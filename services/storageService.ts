
import { User, SystemLog, Room, Message, UserRole } from '../types';
import { db, auth } from './firebase';
import firebase from 'firebase/app';
import 'firebase/firestore';

// --- Users & Auth (Firebase Authentication) ---

// Map a username to a fake email for Firebase Auth (since UI uses username)
const getEmailFromUsername = (username: string) => `${username.toLowerCase()}@securechat.local`;

export const registerUser = async (username: string, password: string): Promise<User> => {
  const email = getEmailFromUsername(username);
  const userCredential = await auth.createUserWithEmailAndPassword(email, password);
  const firebaseUser = userCredential.user;

  if (!firebaseUser) throw new Error("Registration failed");

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
  await db.collection("users").doc(newUser.id).set({
      ...newUser,
      lastLogin: Date.now()
  });

  return newUser;
};

export const loginUser = async (username: string, password: string): Promise<User> => {
  const email = getEmailFromUsername(username);
  const userCredential = await auth.signInWithEmailAndPassword(email, password);
  const firebaseUser = userCredential.user;

  if (!firebaseUser) throw new Error("Login failed");

  const userDoc = await db.collection("users").doc(firebaseUser.uid).get();
  if (userDoc.exists) {
    const userData = userDoc.data() as User;
    await recordUserLogin(userData.id);
    return userData;
  } else {
    throw new Error("User data inconsistent");
  }
};

export const logoutUser = async () => {
  await auth.signOut();
};

export const subscribeToAuthChanges = (callback: (user: User | null) => void) => {
  return auth.onAuthStateChanged(async (firebaseUser) => {
    if (firebaseUser) {
      // Admin is handled locally in App.tsx, this is for regular users
      const userDoc = await db.collection("users").doc(firebaseUser.uid).get();
      if (userDoc.exists) {
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
  const querySnapshot = await db.collection("users").get();
  return querySnapshot.docs.map(doc => doc.data() as User);
};

export const getUserById = async (id: string): Promise<User | undefined> => {
  const docSnap = await db.collection("users").doc(id).get();
  return docSnap.exists ? (docSnap.data() as User) : undefined;
};

export const addUser = async (user: User) => {
  // Legacy support or Admin manual add
  await db.collection("users").doc(user.id).set({
      ...user,
      loginHistory: [], 
      lastLogin: null
  });
};

export const recordUserLogin = async (userId: string) => {
    // Admin ID 'admin-root' might not exist in Firestore
    if (userId === 'admin-root') return;
    
    const userRef = db.collection("users").doc(userId);
    const now = Date.now();
    try {
      await userRef.update({
          lastLogin: now,
          loginHistory: firebase.firestore.FieldValue.arrayUnion(now)
      });
    } catch (e) {
      console.warn("Could not record login history", e);
    }
};

// Real-time User Listener
export const listenToUser = (userId: string, callback: (user: User | null) => void) => {
  if (!userId) return () => {};
  return db.collection("users").doc(userId).onSnapshot((doc) => {
    if (doc.exists) {
      callback(doc.data() as User);
    } else {
      callback(null);
    }
  });
};

// Real-time Friends Listener
export const searchUsersByName = async (username: string): Promise<User[]> => {
  const querySnapshot = await db.collection("users").where("username", "==", username).get();
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

    const targetRef = db.collection("users").doc(targetUser.id);
    await targetRef.update({
      friendRequests: firebase.firestore.FieldValue.arrayUnion(fromUserId)
    });

    return { success: true, message: 'Request sent' };
  } catch (e: any) {
    return { success: false, message: e.message };
  }
};

export const handleFriendRequest = async (userId: string, requesterId: string, action: 'accept' | 'reject') => {
  const userRef = db.collection("users").doc(userId);
  const userSnap = await userRef.get();
  
  if (!userSnap.exists) return;
  const userData = userSnap.data() as User;
  
  const newRequests = userData.friendRequests.filter(id => id !== requesterId);
  await userRef.update({ friendRequests: newRequests });

  if (action === 'accept') {
    await userRef.update({ friends: firebase.firestore.FieldValue.arrayUnion(requesterId) });
    
    const requesterRef = db.collection("users").doc(requesterId);
    await requesterRef.update({ friends: firebase.firestore.FieldValue.arrayUnion(userId) });

    const roomId = `private-${[userId, requesterId].sort().join('-')}`;
    const roomRef = db.collection("rooms").doc(roomId);
    const roomSnap = await roomRef.get();

    if (!roomSnap.exists) {
       const requesterSnap = await requesterRef.get();
       // Fix: Cast data() to User to safely access username
       const rName = requesterSnap.exists ? (requesterSnap.data() as User).username : 'Unknown';
       
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
      await roomRef.set(newRoom);
    }
  }
};

// --- Rooms ---

export const createRoom = async (room: Room) => {
  await db.collection("rooms").doc(room.id).set(room);
};

export const joinRoom = async (roomId: string, userId: string, isAdmin: boolean = false): Promise<{ success: boolean, error?: string }> => {
  const roomRef = db.collection("rooms").doc(roomId);
  const roomSnap = await roomRef.get();

  if (!roomSnap.exists) return { success: false, error: 'Room not found' };
  const room = roomSnap.data() as Room;

  if (isAdmin) {
     if (!room.participants.includes(userId)) {
        await roomRef.update({ participants: firebase.firestore.FieldValue.arrayUnion(userId) });
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
     await roomRef.update({ participants: firebase.firestore.FieldValue.arrayUnion(userId) });
  }
  return { success: true };
};

// Real-time Room Listener (Metadata Only)
export const listenToRoom = (roomId: string, callback: (room: Room | null) => void) => {
  return db.collection("rooms").doc(roomId).onSnapshot((doc) => {
    if (doc.exists) {
      const data = doc.data() as Room;
      callback({ ...data, messages: [] }); 
    } else {
      callback(null); 
    }
  });
};

// Real-time Messages Listener (Subcollection)
// Returns raw messages (encrypted). Decryption happens in UI layer.
export const listenToMessages = (roomId: string, callback: (messages: Message[]) => void) => {
    const messagesRef = db.collection("rooms").doc(roomId).collection("messages");
    const q = messagesRef.orderBy("timestamp", "asc").limit(200);
    
    return q.onSnapshot((snapshot) => {
        // snapshot is QuerySnapshot here, safe to access docs
        const msgs = snapshot.docs.map(doc => doc.data() as Message);
        callback(msgs);
    });
};

// 自分が参加しているグループのみをリッスンする（パブリック全公開をやめる）
// クライアントサイドフィルタリングで 'group' タイプのみを返す
export const listenToJoinedGroups = (userId: string, callback: (rooms: Room[]) => void) => {
  const q = db.collection("rooms").where("participants", "array-contains", userId);
  return q.onSnapshot((snapshot) => {
    // snapshot is QuerySnapshot here, safe to access docs
    const rooms = snapshot.docs
        .map(doc => doc.data() as Room)
        .filter(r => r.type === 'group'); 
    callback(rooms);
  });
};

export const addMessageToRoom = async (roomId: string, message: Message) => {
  const messageRef = db.collection("rooms").doc(roomId).collection("messages").doc(message.id);
  await messageRef.set(message);
};

export const markMessagesAsRead = async (roomId: string, userId: string, messages: Message[]) => {
  const batch = db.batch();
  let updateCount = 0;
  const maxBatch = 400; 

  for (const msg of messages) {
      if (updateCount >= maxBatch) break;
      if (msg.sender === 'user' && !msg.readBy.includes(userId) && msg.senderName !== userId) { 
          const msgRef = db.collection("rooms").doc(roomId).collection("messages").doc(msg.id);
          batch.update(msgRef, { readBy: firebase.firestore.FieldValue.arrayUnion(userId) });
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
  await db.collection("logs").add(newLog);
};

export const subscribeToSystemLogs = (callback: (logs: SystemLog[]) => void) => {
  const q = db.collection("logs").orderBy("timestamp", "desc").limit(100);
  return q.onSnapshot((snapshot) => {
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

   const roomRef = db.collection("rooms").doc(roomId);
   const roomSnap = await roomRef.get();
   if(!roomSnap.exists) return 'Room error';
   const room = roomSnap.data() as Room;

   if (command === '/kick') {
      const newParticipants = room.participants.filter(id => id !== targetUser.id);
      await roomRef.update({ participants: newParticipants });
      return `User ${targetUsername} kicked.`;
   }

   if (command === '/ban') {
      const newParticipants = room.participants.filter(id => id !== targetUser.id);
      await roomRef.update({ 
          participants: newParticipants,
          bannedUsers: firebase.firestore.FieldValue.arrayUnion(targetUser.id)
      });
      return `User ${targetUsername} banned.`;
   }

   if (command === '/mute') {
      await roomRef.update({ mutedUsers: firebase.firestore.FieldValue.arrayUnion(targetUser.id) });
      return `User ${targetUsername} muted.`;
   }

   return 'Unknown command';
};
