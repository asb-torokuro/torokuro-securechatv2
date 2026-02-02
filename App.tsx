
import { User, SystemLog, Room, Message, UserRole } from '../types';
import { db, auth } from './firebase';
import { 
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "firebase/auth";
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
  addDoc,
  writeBatch
} from "firebase/firestore";

// --- Users & Auth (Firebase Authentication) ---

// Map a username to a fake email for Firebase Auth (since UI uses username)
const getEmailFromUsername = (username: string) => `${username.toLowerCase()}@securechat.local`;

export const registerUser = async (username: string, password: string): Promise<User> => {
  const email = getEmailFromUsername(username);
  const userCredential = await createUserWithEmailAndPassword(auth, email, password);
  const firebaseUser = userCredential.user;

  const newUser: User = {
    id: firebaseUser.uid,
    username: username,
    passwordHash: 'SECURED_BY_FIREBASE_AUTH', // No longer stored locally
    role: UserRole.USER,
    createdAt: Date.now(),
    friends: [],
    friendRequests: [],
    loginHistory: []
  };

  // Create user document in Firestore
  await setDoc(doc(db, "users", newUser.id), {
      ...newUser,
      lastLogin: Date.now()
  });

  return newUser;
};

export const loginUser = async (username: string, password: string): Promise<User> => {
  const email = getEmailFromUsername(username);
  const userCredential = await signInWithEmailAndPassword(auth, email, password);
  const firebaseUser = userCredential.user;

  const userDoc = await getDoc(doc(db, "users", firebaseUser.uid));
  if (userDoc.exists()) {
    const userData = userDoc.data() as User;
    await recordUserLogin(userData.id);
    return userData;
  } else {
    throw new Error("User data inconsistent");
  }
};

export const logoutUser = async () => {
  await signOut(auth);
};

export const subscribeToAuthChanges = (callback: (user: User | null) => void) => {
  return onAuthStateChanged(auth, async (firebaseUser) => {
    if (firebaseUser) {
      // Admin is handled locally in App.tsx, this is for regular users
      const userDoc = await getDoc(doc(db, "users", firebaseUser.uid));
      if (userDoc.exists()) {
        callback(userDoc.data() as User);
      } else {
        // Fallback for admin manual login which might not be in auth
        callback(null);
      }
    } else {
      callback(null);
    }
  });
};

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
  // Legacy support or Admin manual add
  await setDoc(doc(db, "users", user.id), {
      ...user,
      loginHistory: [], 
      lastLogin: null
  });
};

export const recordUserLogin = async (userId: string) => {
    // Admin ID 'admin-root' might not exist in Firestore
    if (userId === 'admin-root') return;
    
    const userRef = doc(db, "users", userId);
    const now = Date.now();
    try {
      await updateDoc(userRef, {
          lastLogin: now,
          loginHistory: arrayUnion(now)
      });
    } catch (e) {
      console.warn("Could not record login history", e);
    }
};

// Real-time User Listener
export const listenToUser = (userId: string, callback: (user: User | null) => void) => {
  if (!userId) return () => {};
  return onSnapshot(doc(db, "users", userId), (docSnap) => {
    if (docSnap.exists()) {
      callback(docSnap.data() as User);
    } else {
      callback(null);
    }
  });
};

// Real-time Friends Listener
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
  
  const newRequests = userData.friendRequests.filter(id => id !== requesterId);
  await updateDoc(userRef, { friendRequests: newRequests });

  if (action === 'accept') {
    await updateDoc(userRef, { friends: arrayUnion(requesterId) });
    
    const requesterRef = doc(db, "users", requesterId);
    await updateDoc(requesterRef, { friends: arrayUnion(userId) });

    const roomId = `private-${[userId, requesterId].sort().join('-')}`;
    const roomRef = doc(db, "rooms", roomId);
    const roomSnap = await getDoc(roomRef);

    if (!roomSnap.exists()) {
       const requesterSnap = await getDoc(requesterRef);
       const rName = requesterSnap.exists() ? (requesterSnap.data() as User).username : 'Unknown';
       
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

// Real-time Room Listener (Metadata Only)
export const listenToRoom = (roomId: string, callback: (room: Room | null) => void) => {
  return onSnapshot(doc(db, "rooms", roomId), (docSnap) => {
    if (docSnap.exists()) {
      const data = docSnap.data() as Room;
      callback({ ...data, messages: [] }); 
    } else {
      callback(null); 
    }
  });
};

// Real-time Messages Listener (Subcollection)
// Returns raw messages (encrypted). Decryption happens in UI layer.
export const listenToMessages = (roomId: string, callback: (messages: Message[]) => void) => {
    const messagesRef = collection(db, "rooms", roomId, "messages");
    const q = query(messagesRef, orderBy("timestamp", "asc"), limit(200));
    
    return onSnapshot(q, (snapshot) => {
        const msgs = snapshot.docs.map(doc => doc.data() as Message);
        callback(msgs);
    });
};

// 自分が参加しているグループのみをリッスンする（パブリック全公開をやめる）
// クライアントサイドフィルタリングで 'group' タイプのみを返す
export const listenToJoinedGroups = (userId: string, callback: (rooms: Room[]) => void) => {
  const q = query(collection(db, "rooms"), where("participants", "array-contains", userId));
  return onSnapshot(q, (snapshot) => {
    const rooms = snapshot.docs
        .map(doc => doc.data() as Room)
        .filter(r => r.type === 'group'); 
    callback(rooms);
  });
};

export const addMessageToRoom = async (roomId: string, message: Message) => {
  const messageRef = doc(db, "rooms", roomId, "messages", message.id);
  await setDoc(messageRef, message);
};

export const markMessagesAsRead = async (roomId: string, userId: string, messages: Message[]) => {
  const batch = writeBatch(db);
  let updateCount = 0;
  const maxBatch = 400; 

  for (const msg of messages) {
      if (updateCount >= maxBatch) break;
      if (msg.sender === 'user' && !msg.readBy.includes(userId) && msg.senderName !== userId) { 
          const msgRef = doc(db, "rooms", roomId, "messages", msg.id);
          batch.update(msgRef, { readBy: arrayUnion(userId) });
          updateCount++;
      }
  }

  if (updateCount > 0) {
      try {
        await batch.commit();
      } catch (e) {
          console.error("Batch update failed", e);
      }
  }
};

// --- Logs ---
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

export const subscribeToSystemLogs = (callback: (logs: SystemLog[]) => void) => {
  const q = query(collection(db, "logs"), orderBy("timestamp", "desc"), limit(100));
  return onSnapshot(q, (snapshot) => {
    const logs = snapshot.docs.map(doc => doc.data() as SystemLog);
    callback(logs);
  });
};

export const clearLogs = async () => {
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
