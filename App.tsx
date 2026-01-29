import React, { useState, useEffect, useRef } from 'react';
import { User, UserRole, Message, Room } from './types';
import { 
  ADMIN_USERNAME, 
  ADMIN_PASSWORD, 
  MAX_FILE_SIZE_BYTES,
  CHAT_MODEL,
  VISION_MODEL
} from './constants';
import { hashPassword, verifyPassword, encryptMessage, decryptMessage, formatBytes } from './utils/security';
import { 
  addUser, getUsers, addLog, createRoom, joinRoom, addMessageToRoom, 
  markMessagesAsRead, sendFriendRequest, handleFriendRequest, getUserById,
  executeCommand, listenToUser, listenToRoom, listenToPublicRooms, searchUsersByName, recordUserLogin
} from './services/storageService';
import AdminPanel from './components/AdminPanel';
import VoiceInterface from './components/VoiceInterface';
import { GoogleGenAI } from '@google/genai';

const App = () => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  
  // Auth State
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState<{type: 'username' | 'password' | 'general' | null, message: string}>({ type: null, message: '' });
  const [isAuthProcessing, setIsAuthProcessing] = useState(false);

  // Room State
  const [currentRoom, setCurrentRoom] = useState<Room | null>(null);
  const [joinRoomId, setJoinRoomId] = useState('');
  const [newRoomName, setNewRoomName] = useState('');
  const [availableRooms, setAvailableRooms] = useState<Room[]>([]);

  // Friend State
  const [friendSearchName, setFriendSearchName] = useState('');
  const [friendRequestMsg, setFriendRequestMsg] = useState('');
  const [myFriendObjects, setMyFriendObjects] = useState<User[]>([]);

  // Chat State
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const apiKey = process.env.API_KEY || ''; 

  // --- Real-time Listeners ---
  
  // 1. Listen to Current User Updates (Friends, Requests)
  useEffect(() => {
    if (!currentUser) return;
    // Subscribe to Firestore updates for my user profile
    const unsubscribe = listenToUser(currentUser.id, (updatedUser) => {
        if (updatedUser) {
             setCurrentUser(updatedUser);
             // Also fetch friend objects details
             const fetchFriends = async () => {
                 const friendsData: User[] = [];
                 for(const fid of updatedUser.friends) {
                     const f = await getUserById(fid);
                     if(f) friendsData.push(f);
                 }
                 setMyFriendObjects(friendsData);
             };
             fetchFriends();
        } else {
            // User deleted?
            logout();
        }
    });
    return () => unsubscribe();
  }, [currentUser?.id]);

  // 2. Listen to Current Room Updates (Messages)
  useEffect(() => {
    if (!currentRoom) return;
    const unsubscribe = listenToRoom(currentRoom.id, (updatedRoom) => {
         if (!updatedRoom) {
             alert("Room closed or unavailable.");
             setCurrentRoom(null);
             return;
         }
         // Check kick/ban
         if (currentUser && updatedRoom.bannedUsers.includes(currentUser.id) && currentUser.role !== UserRole.ADMIN) {
             alert("You have been banned.");
             setCurrentRoom(null);
             return;
         }
         if (currentUser && !updatedRoom.participants.includes(currentUser.id) && currentUser.role !== UserRole.ADMIN) {
             alert("You have been kicked.");
             setCurrentRoom(null);
             return;
         }
         setCurrentRoom(updatedRoom);
    });
    return () => unsubscribe();
  }, [currentRoom?.id]);

  // 3. Listen to Public Rooms (Lobby)
  useEffect(() => {
      if (!currentUser && currentUser?.role !== UserRole.ADMIN) return;
      const unsubscribe = listenToPublicRooms((rooms) => {
          setAvailableRooms(rooms);
      });
      return () => unsubscribe();
  }, [currentUser]);


  // 4. Mark Read
  useEffect(() => {
    if (currentRoom && currentUser) {
      markMessagesAsRead(currentRoom.id, currentUser.id, currentRoom);
    }
  }, [currentRoom?.messages.length]);


  // --- Auth Handlers ---
  const withTimeout = <T,>(promise: Promise<T>, ms: number = 5000): Promise<T> => {
      return Promise.race([
          promise,
          new Promise<T>((_, reject) => setTimeout(() => reject(new Error("Database connection timeout. Check your Firebase Config in services/firebase.ts")), ms))
      ]);
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError({ type: null, message: '' });
    setIsAuthProcessing(true);

    try {
        if (!username || !password) {
        setAuthError({ type: 'general', message: 'Credentials required.' });
        return;
        }

        // 1. Check Admin
        if (username === ADMIN_USERNAME) {
            if(password === ADMIN_PASSWORD) {
                const adminUser: User = {
                    id: 'admin-root',
                    username: ADMIN_USERNAME,
                    passwordHash: hashPassword(ADMIN_PASSWORD),
                    role: UserRole.ADMIN,
                    createdAt: Date.now(),
                    friends: [],
                    friendRequests: []
                };
                setCurrentUser(adminUser);
                addLog('LOGIN_SUCCESS', `Admin access granted`, 'alert');
                return;
            } else {
                setAuthError({ type: 'password', message: 'Invalid password.' });
                return;
            }
        }

        if (isLogin) {
            // Login - wrapped in timeout
            const foundUsers = await withTimeout(searchUsersByName(username));
            
            if (foundUsers.length === 0) {
                setAuthError({ type: 'username', message: 'User not found.' });
                return;
            }
            const user = foundUsers[0];
            if (verifyPassword(password, user.passwordHash)) {
                setCurrentUser(user);
                // Don't await this one to avoid blocking UI if it's slow
                recordUserLogin(user.id).catch(console.error);
                addLog('LOGIN_SUCCESS', `User ${username} logged in`, 'info');
            } else {
                setAuthError({ type: 'password', message: 'Invalid password.' });
                addLog('LOGIN_FAIL', `Bad password for ${username}`, 'warning');
            }
        } else {
            // Register - wrapped in timeout
            const foundUsers = await withTimeout(searchUsersByName(username));
            
            if (foundUsers.length > 0) {
                setAuthError({ type: 'username', message: 'Username taken.' });
                return;
            }
            const newUser: User = {
                id: Date.now().toString(),
                username,
                passwordHash: hashPassword(password),
                role: UserRole.USER,
                createdAt: Date.now(),
                friends: [],
                friendRequests: [],
                loginHistory: []
            };
            await withTimeout(addUser(newUser));
            recordUserLogin(newUser.id).catch(console.error);
            setCurrentUser(newUser);
            addLog('REGISTER', `New user registered: ${username}`, 'info');
        }
    } catch (error: any) {
        console.error(error);
        setAuthError({ type: 'general', message: error.message });
    } finally {
        setIsAuthProcessing(false);
    }
  };

  const logout = () => {
    if(currentUser) addLog('LOGOUT', `User ${currentUser.username} logged out`, 'info');
    setCurrentUser(null);
    setCurrentRoom(null);
    setUsername('');
    setPassword('');
    setAuthError({ type: null, message: '' });
  };

  // --- Room Handlers ---
  const handleCreateRoom = async () => {
    if (!newRoomName.trim() || !currentUser) return;
    
    // Generate 7 digit random ID
    const roomId = Math.floor(1000000 + Math.random() * 9000000).toString();
    
    const newRoom: Room = {
      id: roomId,
      name: newRoomName,
      type: 'group',
      creatorId: currentUser.id,
      createdAt: Date.now(),
      participants: [currentUser.id],
      messages: [],
      bannedUsers: [],
      mutedUsers: []
    };

    await createRoom(newRoom);
    // Auto join by setting ID (listener will pick it up after we run joinRoom inside create usually, but here createRoom just saves it)
    // We need to explicitly set currentRoom locally or wait for it.
    // However, since we are the creator, we should jump in.
    setCurrentRoom(newRoom); 
    addLog('ROOM_CREATE', `Group Room ${roomId} created by ${currentUser.username}`, 'info');
    setNewRoomName('');
  };

  const handleJoinRoom = async (id?: string) => {
    const targetId = id || joinRoomId;
    if (!targetId.trim() || !currentUser) return;

    const isAdmin = currentUser.role === UserRole.ADMIN;
    const result = await joinRoom(targetId, currentUser.id, isAdmin);
    
    if (result.success) {
        // We set current room. The useEffect listener will fetch the full data.
        // But we need initial data to avoid null flash.
        // For simplicity, we assume success means we can start listening.
        // We will fetch it once to set state.
        // But wait, listenToRoom needs an ID.
        // We can just set a dummy object with ID and let listener fill it, 
        // OR fetch once.
        addLog('ROOM_JOIN', `User ${currentUser.username} joining ${targetId}`, 'info');
        setJoinRoomId('');
        // To trigger the listener:
        setCurrentRoom({ id: targetId } as Room);
    } else {
      alert(result.error || 'Room not found or access denied');
    }
  };

  // --- Friend Handlers ---
  const handleSendRequest = async () => {
      if(!currentUser || !friendSearchName.trim()) return;
      setFriendRequestMsg('Sending...');
      const res = await sendFriendRequest(currentUser.id, friendSearchName);
      setFriendRequestMsg(res.message);
      if(res.success) setFriendSearchName('');
      setTimeout(() => setFriendRequestMsg(''), 3000);
  };

  const handleRequestAction = async (requesterId: string, action: 'accept' | 'reject') => {
      if(!currentUser) return;
      await handleFriendRequest(currentUser.id, requesterId, action);
  };

  // --- Chat Handlers ---
  const handleSendMessage = async (file?: File) => {
    if ((!inputText.trim() && !file) || !currentUser || !apiKey || !currentRoom) return;

    // Check Mute (locally first for speed)
    if (currentRoom.mutedUsers?.includes(currentUser.id) && currentUser.role !== UserRole.ADMIN) {
        alert("TRANSMISSION BLOCKED: You are muted.");
        return;
    }

    if (inputText.startsWith('/')) {
        if (currentUser.role === UserRole.ADMIN) {
            const parts = inputText.split(' ');
            const command = parts[0];
            const target = parts[1];
            if (target) {
                const result = await executeCommand(currentRoom.id, currentUser.id, command, target);
                const sysMsg: Message = {
                    id: Date.now().toString(),
                    sender: 'system',
                    content: encryptMessage(`ADMIN CMD: ${result}`),
                    timestamp: Date.now(),
                    type: 'text',
                    isEncrypted: true,
                    readBy: []
                };
                await addMessageToRoom(currentRoom.id, sysMsg);
                setInputText('');
                return;
            }
        }
    }

    const timestamp = Date.now();
    let msgType: Message['type'] = 'text';
    let base64File = '';

    // File Processing
    if (file) {
      if (file.size > MAX_FILE_SIZE_BYTES) {
        alert(`File too large. Limit is 10GB.`);
        return;
      }
      
      const isImage = file.type.startsWith('image/');
      msgType = isImage ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'file';
      
      if (file.size < 5 * 1024 * 1024) {
        base64File = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
             const result = reader.result as string;
             resolve(result.split(',')[1]); 
          };
          reader.readAsDataURL(file);
        });
      }
    }

    // 1. Add User Message
    const userMsg: Message = {
      id: Date.now().toString(),
      sender: 'user',
      senderName: currentUser.username,
      content: encryptMessage(inputText || (file ? `Sent a file: ${file.name}` : '')),
      timestamp,
      type: msgType,
      fileName: file?.name,
      fileSize: file?.size,
      isEncrypted: true,
      readBy: []
    };

    await addMessageToRoom(currentRoom.id, userMsg);

    const prompt = inputText;
    setInputText('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    
    // Log Activity
    addLog('MESSAGE_SENT', `User ${currentUser.username} sent message`, 'info');

    // 2. Call Gemini ONLY if invoked with @ai
    if (prompt.toLowerCase().includes('@ai')) {
      setIsLoading(true);

      try {
        const ai = new GoogleGenAI({ apiKey });
        let responseText = '';
        const cleanPrompt = prompt.replace(/@ai/ig, '').trim();

        if (base64File && msgType === 'image') {
          const response = await ai.models.generateContent({
              model: VISION_MODEL,
              contents: {
                  parts: [
                      { inlineData: { mimeType: file!.type, data: base64File } },
                      { text: cleanPrompt || "Describe this." }
                  ]
              }
          });
          responseText = response.text || "Analyzed image.";
        } else {
          const response = await ai.models.generateContent({
            model: CHAT_MODEL,
            contents: cleanPrompt || "Hello.",
            config: {
              systemInstruction: "You are a secure encrypted terminal AI participating in a group chat. Keep responses brief."
            }
          });
          responseText = response.text || "Transmission received.";
        }

        const aiMsg: Message = {
          id: (Date.now() + 1).toString(),
          sender: 'ai',
          senderName: 'AI_TERMINAL',
          content: encryptMessage(responseText),
          timestamp: Date.now(),
          type: 'text',
          isEncrypted: true,
          readBy: []
        };
        
        await addMessageToRoom(currentRoom.id, aiMsg);

      } catch (err: any) {
          console.error(err);
          const errorMsg: Message = {
              id: Date.now().toString(),
              sender: 'system',
              content: encryptMessage(`Error: ${err.message}`),
              timestamp: Date.now(),
              type: 'text',
              isEncrypted: true,
              readBy: []
          };
          await addMessageToRoom(currentRoom.id, errorMsg);
          addLog('API_ERROR', err.message, 'warning');
      } finally {
          setIsLoading(false);
      }
    }
  };

  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [currentRoom?.messages]);

  // --- HELPER FOR READ RECEIPTS ---
  const getReadReceiptText = (msg: Message) => {
    if (msg.sender !== 'user' || !currentRoom) return null;
    if (msg.senderName !== currentUser?.username) return null; 

    const readers = msg.readBy ? msg.readBy.filter(id => id !== currentUser.id) : [];
    
    if (readers.length === 0) return <span className="text-gray-600">Delivered</span>;
    
    // We only have IDs, showing just count or 'Read' for simplicity unless we fetch names.
    // For now, let's just say "READ"
    return <span className="text-green-600 font-bold animate-pulse text-[9px]">READ BY {readers.length}</span>;
  };


  // --- RENDER ---

  // 1. Admin View
  if (currentUser?.role === UserRole.ADMIN) {
    return <AdminPanel onLogout={logout} />;
  }

  // 2. Login View
  if (!currentUser) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 p-4 font-mono relative overflow-hidden">
        <div className="absolute inset-0 z-0 opacity-20 pointer-events-none">
             <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle_at_50%_50%,rgba(59,130,246,0.2),transparent_50%)]"></div>
             <div className="absolute bottom-0 right-0 w-96 h-96 bg-primary/5 rounded-full filter blur-3xl animate-pulse-slow"></div>
        </div>

        <div className="bg-gray-800/80 backdrop-blur-md p-8 rounded-lg shadow-[0_0_50px_rgba(0,0,0,0.5)] w-full max-w-md border border-gray-700 relative z-10 border-t-primary/50">
          <div className="text-center mb-8 relative">
            <div className="w-16 h-1 bg-primary mx-auto mb-4 shadow-[0_0_10px_#3b82f6]"></div>
            <h1 className="text-3xl font-bold text-white mb-2 tracking-[0.2em] text-shadow">SECURE CHAT</h1>
            <p className="text-primary text-[10px] uppercase tracking-widest">Biometric Handshake Protocol v4.2</p>
          </div>

          <form onSubmit={handleAuth} className="space-y-6">
            <div className="relative">
              <label className="block text-gray-500 text-[10px] uppercase tracking-wider mb-1">Identity String</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className={`w-full bg-black/50 border ${authError.type === 'username' ? 'border-red-500 text-red-100' : 'border-gray-700 text-white'} p-3 rounded focus:outline-none focus:border-primary transition-colors font-mono tracking-wider`}
                placeholder="USERNAME"
              />
              {authError.type === 'username' && <span className="text-red-500 text-[10px] absolute -bottom-4 right-0">{authError.message}</span>}
            </div>
            <div className="relative">
              <label className="block text-gray-500 text-[10px] uppercase tracking-wider mb-1">Access Key</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={`w-full bg-black/50 border ${authError.type === 'password' ? 'border-red-500 text-red-100' : 'border-gray-700 text-white'} p-3 rounded focus:outline-none focus:border-primary transition-colors font-mono tracking-wider`}
                placeholder="••••••••"
              />
              {authError.type === 'password' && <span className="text-red-500 text-[10px] absolute -bottom-4 right-0">{authError.message}</span>}
            </div>

            {authError.type === 'general' && <div className="text-red-500 text-sm text-center border border-red-900/50 bg-red-900/20 p-2 rounded">{authError.message}</div>}

            <button
              type="submit"
              disabled={isAuthProcessing}
              className="w-full bg-gradient-to-r from-primary-dark to-primary text-white font-bold py-3 rounded border-t border-white/20 hover:brightness-110 transition-all transform active:scale-95 shadow-lg shadow-primary/20 relative overflow-hidden group disabled:opacity-50"
            >
              <span className="relative z-10">{isAuthProcessing ? 'PROCESSING...' : isLogin ? 'AUTHENTICATE' : 'INITIALIZE NEW ID'}</span>
              <div className="absolute inset-0 h-full w-full bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:animate-[shimmer_1s_infinite]"></div>
            </button>
          </form>

          <div className="mt-8 text-center border-t border-gray-700 pt-4">
            <button
              onClick={() => { setIsLogin(!isLogin); setAuthError({type: null, message: ''}); }}
              className="text-gray-500 hover:text-primary text-xs tracking-wider transition-colors"
            >
              {isLogin ? '[ CREATE NEW IDENTITY ]' : '[ RETURN TO LOGIN ]'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 3. Lobby View (Room Selection)
  if (!currentRoom) {
     const requestUsers = currentUser.friendRequests; // IDs only
     
     return (
        <div className="min-h-screen bg-gray-900 text-gray-100 font-mono flex flex-col">
            <header className="p-4 flex justify-between items-center border-b border-gray-800 bg-gray-900/90 backdrop-blur sticky top-0 z-20">
                <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded bg-primary/20 flex items-center justify-center text-primary font-bold border border-primary/50">
                       {currentUser.username.substring(0,2).toUpperCase()}
                    </div>
                    <div>
                       <div className="text-white font-bold tracking-wider">{currentUser.username}</div>
                       <div className="text-[10px] text-green-500">ONLINE // ID: {currentUser.id.slice(-6)}</div>
                    </div>
                </div>
                <button onClick={logout} className="text-red-500 hover:text-red-400 text-xs border border-red-900 hover:border-red-500 px-3 py-1 rounded transition-colors">ABORT SESSION</button>
            </header>

            <div className="flex-1 overflow-auto p-4 md:p-8">
                <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-8">
                    
                    {/* LEFT COL: Channels */}
                    <div className="lg:col-span-2 space-y-8">
                        {/* Create/Join */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="bg-gray-800/50 p-6 rounded-xl border border-primary/20 hover:border-primary/50 transition-all">
                                <h2 className="text-lg font-bold mb-4 text-white flex items-center gap-2"><span className="text-primary">✚</span> INITIALIZE CHANNEL</h2>
                                <div className="flex gap-2">
                                    <input 
                                        type="text" 
                                        placeholder="Channel Name"
                                        value={newRoomName}
                                        onChange={(e) => setNewRoomName(e.target.value)}
                                        className="flex-1 bg-gray-900 border border-gray-700 text-white p-2 rounded focus:border-primary focus:outline-none text-sm"
                                    />
                                    <button onClick={handleCreateRoom} className="bg-primary hover:bg-primary-dark text-white px-4 rounded text-sm font-bold">→</button>
                                </div>
                            </div>
                            <div className="bg-gray-800/50 p-6 rounded-xl border border-green-500/20 hover:border-green-500/50 transition-all">
                                <h2 className="text-lg font-bold mb-4 text-white flex items-center gap-2"><span className="text-green-500">⚡</span> JOIN FREQUENCY</h2>
                                <div className="flex gap-2">
                                    <input 
                                        type="text" 
                                        placeholder="ID (7-digits)"
                                        maxLength={7}
                                        value={joinRoomId}
                                        onChange={(e) => setJoinRoomId(e.target.value)}
                                        className="flex-1 bg-gray-900 border border-gray-700 text-white p-2 rounded focus:border-green-500 focus:outline-none text-sm text-center tracking-widest"
                                    />
                                    <button onClick={() => handleJoinRoom()} className="bg-green-600 hover:bg-green-700 text-white px-4 rounded text-sm font-bold">→</button>
                                </div>
                            </div>
                        </div>

                        {/* Recent Rooms */}
                        <div>
                            <h3 className="text-gray-500 text-xs font-bold mb-4 tracking-widest">ACTIVE CHANNELS</h3>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                {availableRooms.filter(r => r.participants.includes(currentUser.id)).map(r => (
                                    <button key={r.id} onClick={() => handleJoinRoom(r.id)} className="bg-gray-800 border border-gray-700 p-4 rounded hover:bg-gray-700 hover:border-primary/50 text-left transition-all group relative overflow-hidden">
                                        <div className="absolute top-0 right-0 p-1">
                                            <div className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_5px_#22c55e]"></div>
                                        </div>
                                        <div className="font-bold text-gray-200 group-hover:text-primary">{r.name}</div>
                                        <div className="text-xs text-gray-500 font-mono">#{r.id}</div>
                                    </button>
                                ))}
                                {availableRooms.filter(r => r.participants.includes(currentUser.id)).length === 0 && (
                                    <div className="text-gray-600 text-sm italic">No active channels detected.</div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* RIGHT COL: Friends */}
                    <div className="bg-gray-800/30 border-l border-gray-800 pl-8 space-y-8">
                        
                        {/* Add Friend */}
                        <div>
                            <h3 className="text-gray-500 text-xs font-bold mb-4 tracking-widest">ADD CONTACT</h3>
                            <div className="flex gap-2 mb-2">
                                <input 
                                    type="text" 
                                    placeholder="Username"
                                    value={friendSearchName}
                                    onChange={(e) => setFriendSearchName(e.target.value)}
                                    className="w-full bg-gray-900 border border-gray-700 text-white p-2 rounded focus:border-primary focus:outline-none text-xs"
                                />
                                <button onClick={handleSendRequest} className="bg-gray-700 hover:bg-gray-600 text-white px-3 rounded text-xs">ADD</button>
                            </div>
                            {friendRequestMsg && <div className={`text-[10px] ${friendRequestMsg.includes('sent') ? 'text-green-500' : 'text-red-500'}`}>{friendRequestMsg}</div>}
                        </div>

                        {/* Requests */}
                        {requestUsers.length > 0 && (
                            <div>
                                <h3 className="text-yellow-500 text-xs font-bold mb-4 tracking-widest animate-pulse">PENDING REQUESTS</h3>
                                <div className="space-y-2">
                                    {requestUsers.map(uid => (
                                        <div key={uid} className="bg-yellow-900/10 border border-yellow-900/30 p-2 rounded flex justify-between items-center">
                                            <span className="text-sm font-bold text-yellow-100">{uid} (ID)</span>
                                            <div className="flex gap-1">
                                                <button onClick={() => handleRequestAction(uid, 'accept')} className="text-green-500 hover:bg-green-900/20 p-1 rounded">✓</button>
                                                <button onClick={() => handleRequestAction(uid, 'reject')} className="text-red-500 hover:bg-red-900/20 p-1 rounded">✕</button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Friends List */}
                        <div>
                            <h3 className="text-gray-500 text-xs font-bold mb-4 tracking-widest">ENCRYPTED CONTACTS</h3>
                            <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-gray-700">
                                {myFriendObjects.map(f => {
                                    // Construct private ID again
                                    const privateRoomId = `private-${[currentUser.id, f.id].sort().join('-')}`;
                                    
                                    return (
                                        <div key={f.id} className="group flex items-center justify-between p-2 rounded hover:bg-gray-800 transition-colors cursor-pointer" onClick={() => handleJoinRoom(privateRoomId)}>
                                            <div className="flex items-center gap-3">
                                                <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                                                <span className="text-sm text-gray-300 group-hover:text-white">{f.username}</span>
                                            </div>
                                            <svg className="w-4 h-4 text-gray-600 group-hover:text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path></svg>
                                        </div>
                                    );
                                })}
                                {myFriendObjects.length === 0 && <div className="text-gray-700 text-xs text-center py-4">No contacts added.</div>}
                            </div>
                        </div>

                    </div>
                </div>
            </div>
        </div>
     );
  }

  // 4. Chat View
  // Ensure currentRoom messages is not undefined (could happen during init)
  const messages = currentRoom.messages || [];

  return (
    <div className="flex flex-col h-screen bg-gray-900 text-gray-100 font-mono overflow-hidden">
      {/* Header */}
      <header className="flex-none h-16 bg-gray-800 border-b border-gray-700 flex items-center justify-between px-6 shadow-md z-10">
        <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full ${currentRoom.type === 'private' ? 'bg-blue-500' : 'bg-green-500'} animate-pulse`}></div>
            <div>
                <h2 className="text-lg font-bold text-white tracking-wider flex items-center gap-2">
                   {currentRoom.type === 'private' ? currentRoom.name.replace(currentUser.username, '').replace('&', '').trim() : currentRoom.name} 
                   {currentRoom.type === 'group' && <span className="text-primary bg-primary/10 px-2 py-0.5 rounded text-xs">#{currentRoom.id}</span>}
                </h2>
                <div className="text-[10px] text-gray-400">
                    {currentRoom.type === 'private' ? 'DIRECT ENCRYPTED LINK' : `PARTICIPANTS: ${currentRoom.participants?.length || 0} // ID: ${currentUser.username}`}
                </div>
            </div>
        </div>
        <div className="flex gap-4">
            <button 
                onClick={() => setIsVoiceActive(true)}
                className="bg-gray-700 hover:bg-gray-600 text-green-400 px-4 py-2 rounded border border-gray-600 flex items-center gap-2 transition-colors"
            >
                <span className="w-2 h-2 rounded-full bg-green-400"></span>
                VOICE LINK
            </button>
            <button 
                onClick={() => setCurrentRoom(null)}
                className="text-gray-400 hover:text-white text-sm uppercase tracking-wide border border-gray-700 hover:border-gray-500 px-3 py-2 rounded"
            >
                CLOSE LINK
            </button>
        </div>
      </header>

      {/* Messages Area */}
      <div 
        ref={chatContainerRef}
        className="flex-1 overflow-y-auto p-4 space-y-6 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent"
      >
        {messages.map((msg) => {
            const isMe = msg.sender === 'user' && msg.senderName === currentUser.username;
            const decryptedContent = decryptMessage(msg.content);

            return (
                <div key={msg.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[70%] ${isMe ? 'items-end' : 'items-start'} flex flex-col`}>
                        <div className={`flex items-center gap-2 mb-1 text-[10px] text-gray-500 uppercase`}>
                            <span>{msg.sender === 'ai' ? 'AI TERMINAL' : msg.senderName || 'Unknown'}</span>
                            <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                            {msg.isEncrypted && (
                                <span className="text-green-600 flex items-center gap-1">
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>
                                    AES
                                </span>
                            )}
                        </div>
                        
                        <div className={`p-4 rounded-lg relative overflow-hidden group border ${
                            isMe 
                            ? 'bg-primary/10 border-primary/30 text-blue-100 rounded-tr-none' 
                            : msg.sender === 'system' ? 'bg-red-900/20 border-red-800 text-red-200'
                            : 'bg-gray-800 border-gray-700 text-gray-200 rounded-tl-none'
                        }`}>
                            
                            {/* File Attachment Indicator */}
                            {msg.fileName && (
                                <div className="mb-3 flex items-center gap-3 bg-black/20 p-2 rounded border border-white/10">
                                    <div className="text-2xl">
                                        {msg.type === 'image' ? '🖼️' : msg.type === 'video' ? '🎥' : msg.type === 'audio' ? '🎵' : '📁'}
                                    </div>
                                    <div>
                                        <div className="font-bold text-xs truncate max-w-[150px]">{msg.fileName}</div>
                                        <div className="text-[10px] opacity-70">{formatBytes(msg.fileSize || 0)}</div>
                                    </div>
                                </div>
                            )}

                            <div className="whitespace-pre-wrap leading-relaxed">{decryptedContent}</div>
                        </div>

                        {/* Read Receipts Display */}
                        {isMe && (
                             <div className="mt-1 flex justify-end">
                                {getReadReceiptText(msg)}
                             </div>
                        )}
                    </div>
                </div>
            );
        })}
        {isLoading && (
             <div className="flex justify-start">
                 <div className="bg-gray-800 p-4 rounded-lg rounded-tl-none border border-gray-700 flex items-center gap-2">
                     <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce"></div>
                     <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce delay-75"></div>
                     <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce delay-150"></div>
                 </div>
             </div>
        )}
      </div>

      {/* Input Area */}
      <footer className="flex-none p-4 bg-gray-800 border-t border-gray-700">
        <div className="max-w-4xl mx-auto flex gap-4 items-end">
            <button 
                onClick={() => fileInputRef.current?.click()}
                className="p-3 text-gray-400 hover:text-white bg-gray-700 rounded-lg hover:bg-gray-600 transition-colors"
                title="Attach 10GB Max"
            >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"></path></svg>
            </button>
            <input 
                type="file" 
                ref={fileInputRef} 
                className="hidden" 
                onChange={(e) => {
                    if (e.target.files?.[0]) handleSendMessage(e.target.files[0]);
                }}
            />

            <div className="flex-1 bg-gray-900 rounded-lg border border-gray-600 focus-within:border-primary transition-colors flex items-center relative">
                <textarea
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleSendMessage();
                        }
                    }}
                    placeholder={`Encrypting to #${currentRoom.type === 'private' ? 'DIRECT' : currentRoom.id}... (Type @ai to summon bot)`}
                    className="w-full bg-transparent text-white p-3 max-h-32 focus:outline-none resize-none"
                    rows={1}
                />
            </div>

            <button 
                onClick={() => handleSendMessage()}
                disabled={isLoading || (!inputText.trim() && !fileInputRef.current?.value)}
                className="p-3 bg-primary hover:bg-primary-dark text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all transform active:scale-95"
            >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"></path></svg>
            </button>
        </div>
      </footer>

      {/* Voice Modal */}
      {isVoiceActive && (
          <VoiceInterface 
            apiKey={apiKey} 
            isActive={isVoiceActive} 
            onClose={() => setIsVoiceActive(false)} 
          />
      )}
    </div>
  );
};

export default App;