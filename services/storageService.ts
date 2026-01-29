import { User, SystemLog, Room, Message, UserRole } from '../types';
import { db } from './firebase';
import { 
  collection, 
  doc, 
  setDoc, 
  getDoc, 
  getDocs, 
  updateDoc, 
  arrayUnion, 
  onSnapshot, 
  query, 
  where,
  orderBy,
  limit,
  addDoc
} from "firebase/firestore";

// --- Users & Auth ---

export const getUsers = async (): Promise<User[]> => {
  const querySnapshot = await getDocs(collection(db, "users"));
  return querySnapshot.docs.map(doc => doc.data() as User);
};

export const getUserById = async (id: string): Promise<User | undefined> => {
  const docRef = doc(db, "users", id);
  const docSnap = await getDoc(docRef);
  return docSnap.exists() ? (docSnap.data() as User) : undefined;
};

export const addUser = async (user: User) => {
  await setDoc(doc(db, "users", user.id), {
      ...user,
      loginHistory: [], 
      lastLogin: null
  });
};

export const recordUserLogin = async (userId: string) => {
    const userRef = doc(db, "users", userId);
    const now = Date.now();
    await updateDoc(userRef, {
        lastLogin: now,
        loginHistory: arrayUnion(now)
    });
};

// Real-time User Listener
export const listenToUser = (userId: string, callback: (user: User | null) => void) => {
  return onSnapshot(doc(db, "users", userId), (doc) => {
    if (doc.exists()) {
      callback(doc.data() as User);
    } else {
      callback(null);
    }
  });
};

// Real-time Friends Listener (Actually just listenting to user updates covers this, 
// but we might need to fetch friend details)
export const searchUsersByName = async (username: string): Promise<User[]> => {
  const q = query(collection(db, "users"), where("username", "==", username));
  const querySnapshot = await getDocs(q);
  return querySnapshot.docs.map(doc => doc.data() as User);
};

export const sendFriendRequest = async (fromUserId: string, toUsername: string): Promise<{ success: boolean, message: string }> => {
  try {
    const targets = await searchUsersByName(toUsername);
    if (targets.length === 0) return { success: false, message: 'User not found' };
    
    const targetUser = targets[0];
    if (targetUser.id === fromUserId) return { success: false, message: 'Cannot add yourself' };
    if (targetUser.friends.includes(fromUserId)) return { success: false, message: 'Already friends' };
    if (targetUser.friendRequests.includes(fromUserId)) return { success: false, message: 'Request already sent' };

    // Update target user's friendRequests
    const targetRef = doc(db, "users", targetUser.id);
    await updateDoc(targetRef, {
      friendRequests: arrayUnion(fromUserId)
    });

    return { success: true, message: 'Request sent' };
  } catch (e: any) {
    return { success: false, message: e.message };
  }
};

export const handleFriendRequest = async (userId: string, requesterId: string, action: 'accept' | 'reject') => {
  const userRef = doc(db, "users", userId);
  const userSnap = await getDoc(userRef);
  
  if (!userSnap.exists()) return;
  const userData = userSnap.data() as User;
  
  // Remove from requests
  const newRequests = userData.friendRequests.filter(id => id !== requesterId);
  await updateDoc(userRef, { friendRequests: newRequests });

  if (action === 'accept') {
    // Add to my friends
    await updateDoc(userRef, { friends: arrayUnion(requesterId) });
    
    // Add me to requester's friends
    const requesterRef = doc(db, "users", requesterId);
    await updateDoc(requesterRef, { friends: arrayUnion(userId) });

    // Create Private Room
    const roomId = `private-${[userId, requesterId].sort().join('-')}`;
    const roomRef = doc(db, "rooms", roomId);
    const roomSnap = await getDoc(roomRef);

    if (!roomSnap.exists()) {
       // Need usernames for the room name... ideally we fetch them, but for now:
       const requesterSnap = await getDoc(requesterRef);
       const rName = requesterSnap.exists() ? requesterSnap.data().username : 'Unknown';
       
       const newRoom: Room = {
        id: roomId,
        name: `${rName} & ${userData.username}`,
        type: 'private',
        creatorId: 'system',
        createdAt: Date.now(),
        participants: [userId, requesterId],
        messages: [],
        bannedUsers: [],
        mutedUsers: []
      };
      await setDoc(roomRef, newRoom);
    }
  }
};

// --- Rooms ---

export const createRoom = async (room: Room) => {
  await setDoc(doc(db, "rooms", room.id), room);
};

export const joinRoom = async (roomId: string, userId: string, isAdmin: boolean = false): Promise<{ success: boolean, error?: string }> => {
  const roomRef = doc(db, "rooms", roomId);
  const roomSnap = await getDoc(roomRef);

  if (!roomSnap.exists()) return { success: false, error: 'Room not found' };
  const room = roomSnap.data() as Room;

  if (isAdmin) {
     if (!room.participants.includes(userId)) {
        await updateDoc(roomRef, { participants: arrayUnion(userId) });
     }
     return { success: true };
  }

  if (room.bannedUsers.includes(userId)) {
    return { success: false, error: 'Access Denied: Banned.' };
  }
  
  if (room.type === 'private' && !room.participants.includes(userId)) {
    return { success: false, error: 'Access Denied: Private channel.' };
  }

  if (!room.participants.includes(userId)) {
     await updateDoc(roomRef, { participants: arrayUnion(userId) });
  }
  return { success: true };
};

// Real-time Room Listener
export const listenToRoom = (roomId: string, callback: (room: Room | null) => void) => {
  return onSnapshot(doc(db, "rooms", roomId), (doc) => {
    if (doc.exists()) {
      callback(doc.data() as Room);
    } else {
      callback(null); // Room might be deleted or not found
    }
  });
};

// Listen to all public rooms that I am part of (or all public rooms for lobby)
// Simplified: Just listen to all 'group' type rooms
export const listenToPublicRooms = (callback: (rooms: Room[]) => void) => {
  const q = query(collection(db, "rooms"), where("type", "==", "group"));
  return onSnapshot(q, (snapshot) => {
    const rooms = snapshot.docs.map(doc => doc.data() as Room);
    callback(rooms);
  });
};

export const addMessageToRoom = async (roomId: string, message: Message) => {
  const roomRef = doc(db, "rooms", roomId);
  await updateDoc(roomRef, {
    messages: arrayUnion(message)
  });
};

export const markMessagesAsRead = async (roomId: string, userId: string, room: Room) => {
  // Firestore array updates are tricky for nested objects.
  // In a production app, messages should be a subcollection.
  // For this demo structure, we have to read, modify, write back the WHOLE array.
  // We will debounce this or only do it if necessary.
  
  let hasChanges = false;
  const updatedMessages = room.messages.map(msg => {
     if (msg.sender === 'user' && !msg.readBy.includes(userId) && msg.senderName !== userId /* simplified check */) {
        hasChanges = true;
        return { ...msg, readBy: [...msg.readBy, userId] };
     }
     return msg;
  });

  if (hasChanges) {
    const roomRef = doc(db, "rooms", roomId);
    await updateDoc(roomRef, { messages: updatedMessages });
  }
};

// --- Logs ---
// Moving logs to Firestore 'logs' collection
export const addLog = async (event: string, details: string, level: 'info' | 'warning' | 'alert' = 'info') => {
  const newLog: SystemLog = {
    id: Date.now().toString() + Math.random().toString().slice(2, 5),
    timestamp: Date.now(),
    event,
    details,
    level,
  };
  await addDoc(collection(db, "logs"), newLog);
};

export const listenToLogs = (callback: (logs: SystemLog[]) => void) => {
  const q = query(collection(db, "logs"), orderBy("timestamp", "desc"), limit(100));
  return onSnapshot(q, (snapshot) => {
    const logs = snapshot.docs.map(doc => doc.data() as SystemLog);
    callback(logs);
  });
};

export const clearLogs = async () => {
  // Not easily possible to clear all in Firestore without Cloud Functions or iterating delete
  // Skipping for this demo
  console.log("Log clearing not fully implemented for Firestore client-side demo");
};

// --- Commands ---
export const executeCommand = async (roomId: string, adminId: string, command: string, targetUsername: string): Promise<string> => {
   const users = await searchUsersByName(targetUsername);
   if (users.length === 0) return `User ${targetUsername} not found`;
   const targetUser = users[0];

   const roomRef = doc(db, "rooms", roomId);
   const roomSnap = await getDoc(roomRef);
   if(!roomSnap.exists()) return 'Room error';
   const room = roomSnap.data() as Room;

   if (command === '/kick') {
      const newParticipants = room.participants.filter(id => id !== targetUser.id);
      await updateDoc(roomRef, { participants: newParticipants });
      return `User ${targetUsername} kicked.`;
   }

   if (command === '/ban') {
      const newParticipants = room.participants.filter(id => id !== targetUser.id);
      await updateDoc(roomRef, { 
          participants: newParticipants,
          bannedUsers: arrayUnion(targetUser.id)
      });
      return `User ${targetUsername} banned.`;
   }

   if (command === '/mute') {
      await updateDoc(roomRef, { mutedUsers: arrayUnion(targetUser.id) });
      return `User ${targetUsername} muted.`;
   }

   return 'Unknown command';
};