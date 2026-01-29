
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
  
  useEffect(() => {
    if (!currentUser) return;
    
    // 管理者はFirestore上に存在しない仮想ユーザーのため、リスナーを設定しない
    // これを設定するとFirestoreにデータがないため即座にlogout()が呼ばれてしまう
    if (currentUser.role === UserRole.ADMIN) return;

    const unsubscribe = listenToUser(currentUser.id, (updatedUser) => {
        if (updatedUser) {
             setCurrentUser(updatedUser);
             const fetchFriends = async () => {
                 const friendsData: User[] = [];
                 if (updatedUser.friends) {
                    for(const fid of updatedUser.friends) {
                        const f = await getUserById(fid);
                        if(f) friendsData.push(f);
                    }
                 }
                 setMyFriendObjects(friendsData);
             };
             fetchFriends();
        } else {
            logout();
        }
    });
    return () => unsubscribe();
  }, [currentUser?.id, currentUser?.role]);

  useEffect(() => {
    if (!currentRoom) return;
    const unsubscribe = listenToRoom(currentRoom.id, (updatedRoom) => {
         if (!updatedRoom) {
             alert("Room closed or unavailable.");
             setCurrentRoom(null);
             return;
         }
         if (currentUser && updatedRoom.bannedUsers?.includes(currentUser.id) && currentUser.role !== UserRole.ADMIN) {
             alert("You have been banned.");
             setCurrentRoom(null);
             return;
         }
         if (currentUser && !updatedRoom.participants?.includes(currentUser.id) && currentUser.role !== UserRole.ADMIN) {
             alert("You have been kicked.");
             setCurrentRoom(null);
             return;
         }
         setCurrentRoom(updatedRoom);
    });
    return () => unsubscribe();
  }, [currentRoom?.id]);

  useEffect(() => {
      // Fix strict comparison logic for conditional effect
      if (!currentUser) return;
      if (currentUser.role !== UserRole.ADMIN && currentUser.role !== UserRole.USER) return;

      const unsubscribe = listenToPublicRooms((rooms) => {
          setAvailableRooms(rooms);
      });
      return () => unsubscribe();
  }, [currentUser]);

  useEffect(() => {
    if (currentRoom && currentUser && currentRoom.messages) {
      markMessagesAsRead(currentRoom.id, currentUser.id, currentRoom);
    }
  }, [currentRoom?.messages?.length]);

  const withTimeout = <T,>(promise: Promise<T>, ms: number = 8000): Promise<T> => {
      return Promise.race([
          promise,
          new Promise<T>((_, reject) => setTimeout(() => reject(new Error("Database connection timeout. Firebaseの設定を確認してください。")), ms))
      ]);
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError({ type: null, message: '' });
    
    setIsAuthProcessing(true);

    try {
        if (!username || !password) {
            setAuthError({ type: 'general', message: 'ユーザー名とパスワードを入力してください。' });
            return;
        }

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
                setAuthError({ type: 'password', message: '管理者パスワードが違います。' });
                return;
            }
        }

        if (isLogin) {
            const foundUsers = await withTimeout(searchUsersByName(username));
            if (foundUsers.length === 0) {
                setAuthError({ type: 'username', message: 'ユーザーが見つかりません。' });
                return;
            }
            const user = foundUsers[0];
            if (verifyPassword(password, user.passwordHash)) {
                setCurrentUser(user);
                recordUserLogin(user.id).catch(console.error);
                addLog('LOGIN_SUCCESS', `User ${username} logged in`, 'info');
            } else {
                setAuthError({ type: 'password', message: 'パスワードが正しくありません。' });
                addLog('LOGIN_FAIL', `Bad password for ${username}`, 'warning');
            }
        } else {
            const foundUsers = await withTimeout(searchUsersByName(username));
            if (foundUsers.length > 0) {
                setAuthError({ type: 'username', message: 'そのユーザー名は既に使用されています。' });
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

  const handleCreateRoom = async () => {
    if (!newRoomName.trim() || !currentUser) return;
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
        addLog('ROOM_JOIN', `User ${currentUser.username} joining ${targetId}`, 'info');
        setJoinRoomId('');
        setCurrentRoom({ id: targetId } as Room);
    } else {
      alert(result.error || 'Room not found or access denied');
    }
  };

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

  const handleSendMessage = async (file?: File) => {
    // Modified: Removed !apiKey check to allow messages without AI key
    if ((!inputText.trim() && !file) || !currentUser || !currentRoom) return;
    
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

    try {
        await addMessageToRoom(currentRoom.id, userMsg);
        const prompt = inputText;
        setInputText('');
        if (fileInputRef.current) fileInputRef.current.value = '';
        addLog('MESSAGE_SENT', `User ${currentUser.username} sent message`, 'info');

        if (prompt.toLowerCase().includes('@ai')) {
          if (!apiKey) {
             const sysMsg: Message = {
                 id: Date.now().toString(),
                 sender: 'system',
                 content: encryptMessage("SYSTEM: AI capabilities unavailable (Missing API Key)."),
                 timestamp: Date.now(),
                 type: 'text',
                 isEncrypted: true,
                 readBy: []
             };
             await addMessageToRoom(currentRoom.id, sysMsg);
             return;
          }

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
    } catch (e: any) {
        console.error("Failed to send message", e);
        alert("Failed to send message: " + e.message);
    }
  };

  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [currentRoom?.messages]);

  const getReadReceiptText = (msg: Message) => {
    if (msg.sender !== 'user' || !currentRoom) return null;
    if (msg.senderName !== currentUser?.username) return null; 
    const readers = msg.readBy ? msg.readBy.filter(id => id !== currentUser.id) : [];
    if (readers.length === 0) return <span className="text-gray-600">送信済み</span>;
    return <span className="text-green-600 font-bold animate-pulse text-[9px]">既読 {readers.length}</span>;
  };

  // Safe check for admin role to avoid TS overlap error
  if (currentUser && (currentUser.role as UserRole) === UserRole.ADMIN) {
    return <AdminPanel onLogout={logout} />;
  }

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
            <h1 className="text-3xl font-bold text-white mb-2 tracking-[0.2em] text-shadow uppercase">Secure Chat</h1>
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

            {authError.type === 'general' && <div className="text-red-500 text-xs text-center border border-red-900/50 bg-red-900/20 p-3 rounded leading-tight">{authError.message}</div>}

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
              onClick={() => { setIsLogin(!isLogin); setAuthError({ type: null, message: '' }); }}
              className="text-primary text-xs hover:underline uppercase tracking-widest"
            >
              {isLogin ? "Need an account? Register" : "Already have an account? Login"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- Main Chat UI ---

  return (
    <div className="flex h-screen bg-gray-900 text-gray-200 font-sans overflow-hidden">
      {/* Sidebar */}
      <div className="w-80 bg-gray-800 border-r border-gray-700 flex flex-col hidden md:flex">
        <div className="p-4 border-b border-gray-700">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary to-primary-dark flex items-center justify-center text-white font-bold shadow-lg shadow-primary/20">
                {currentUser.username.substring(0,2).toUpperCase()}
            </div>
            <div>
                <div className="font-bold text-white">{currentUser.username}</div>
                <div className="text-[10px] text-primary flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                    ONLINE // ENCRYPTED
                </div>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
            
            {/* Friends Section */}
            <div>
                <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Contacts</h3>
                <div className="flex gap-2 mb-2">
                    <input 
                        type="text" 
                        value={friendSearchName} 
                        onChange={e => setFriendSearchName(e.target.value)}
                        placeholder="Add Username" 
                        className="w-full bg-black/30 border border-gray-700 rounded px-2 py-1 text-xs focus:border-primary outline-none"
                    />
                    <button onClick={handleSendRequest} className="bg-primary/20 text-primary border border-primary/50 rounded px-2 text-xs hover:bg-primary/30">+</button>
                </div>
                {friendRequestMsg && <p className="text-[10px] text-green-500 mb-2">{friendRequestMsg}</p>}
                
                {/* Friend Requests */}
                {currentUser.friendRequests && currentUser.friendRequests.length > 0 && (
                     <div className="mb-2 space-y-1">
                        {currentUser.friendRequests.map(fid => (
                            <div key={fid} className="bg-primary/10 border border-primary/30 p-2 rounded text-xs flex justify-between items-center">
                                <span>Request: {fid}</span> {/* Ideally fetch username */}
                                <div className="flex gap-1">
                                    <button onClick={() => handleRequestAction(fid, 'accept')} className="text-green-400 hover:text-green-300">✔</button>
                                    <button onClick={() => handleRequestAction(fid, 'reject')} className="text-red-400 hover:text-red-300">✖</button>
                                </div>
                            </div>
                        ))}
                     </div>
                )}

                <div className="space-y-1">
                    {myFriendObjects.map(f => (
                        <div 
                            key={f.id} 
                            onClick={() => handleJoinRoom(`private-${[currentUser.id, f.id].sort().join('-')}`)}
                            className="flex items-center gap-2 p-2 hover:bg-white/5 rounded cursor-pointer transition-colors"
                        >
                            <div className="w-2 h-2 rounded-full bg-gray-500"></div>
                            <span className="text-sm">{f.username}</span>
                        </div>
                    ))}
                    {myFriendObjects.length === 0 && <p className="text-[10px] text-gray-600 italic">No active contacts.</p>}
                </div>
            </div>

            {/* Rooms Section */}
            <div>
                <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Channels</h3>
                <div className="flex gap-2 mb-2">
                    <input 
                         type="text" 
                         value={newRoomName}
                         onChange={e => setNewRoomName(e.target.value)}
                         placeholder="New Channel"
                         className="w-full bg-black/30 border border-gray-700 rounded px-2 py-1 text-xs focus:border-primary outline-none"
                    />
                    <button onClick={handleCreateRoom} className="bg-primary/20 text-primary border border-primary/50 rounded px-2 text-xs hover:bg-primary/30">+</button>
                </div>
                 
                <div className="space-y-1">
                    {availableRooms.map(room => (
                         <div 
                            key={room.id}
                            onClick={() => handleJoinRoom(room.id)}
                            className={`flex items-center gap-2 p-2 rounded cursor-pointer transition-colors ${currentRoom?.id === room.id ? 'bg-primary/20 text-primary border border-primary/30' : 'hover:bg-white/5'}`}
                         >
                            <span className="text-xs">#</span>
                            <span className="text-sm truncate">{room.name}</span>
                         </div>
                    ))}
                </div>
            </div>

            {/* Join by ID */}
            <div>
                 <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Direct Link</h3>
                 <div className="flex gap-2">
                     <input 
                         type="text" 
                         value={joinRoomId} 
                         onChange={e => setJoinRoomId(e.target.value)}
                         placeholder="Room ID"
                         className="w-full bg-black/30 border border-gray-700 rounded px-2 py-1 text-xs focus:border-primary outline-none"
                     />
                     <button onClick={() => handleJoinRoom()} className="bg-gray-700 hover:bg-gray-600 rounded px-3 text-xs">JOIN</button>
                 </div>
            </div>
        </div>

        <div className="p-4 border-t border-gray-700">
             <button onClick={logout} className="w-full py-2 bg-red-900/30 text-red-500 border border-red-900/50 hover:bg-red-900/50 rounded text-xs tracking-wider uppercase">Disconnect</button>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col bg-gray-900 relative">
         {!currentRoom ? (
             <div className="flex-1 flex flex-col items-center justify-center text-gray-600 opacity-50">
                 <div className="w-24 h-24 rounded-full border-4 border-gray-700 flex items-center justify-center mb-4">
                     <div className="w-20 h-20 bg-gray-800 rounded-full animate-pulse"></div>
                 </div>
                 <p className="tracking-widest uppercase">Select a frequency to begin transmission</p>
             </div>
         ) : (
             <>
                {/* Chat Header */}
                <div className="h-16 bg-gray-800/50 backdrop-blur border-b border-gray-700 flex justify-between items-center px-6">
                    <div>
                        <h2 className="font-bold text-white flex items-center gap-2">
                            {currentRoom.type === 'private' ? '🔒 PRIVATE LINK' : `# ${currentRoom.name}`}
                            <span className="text-[10px] bg-gray-700 px-1 rounded text-gray-400 font-mono">{currentRoom.id}</span>
                        </h2>
                        <p className="text-[10px] text-gray-400">{currentRoom.participants ? currentRoom.participants.length : 0} connected entities</p>
                    </div>
                    <div className="flex gap-4">
                        <button 
                            onClick={() => setIsVoiceActive(true)}
                            className="bg-primary/20 hover:bg-primary/30 text-primary px-3 py-1 rounded-full border border-primary/50 text-xs flex items-center gap-2 transition-all shadow-[0_0_15px_rgba(59,130,246,0.2)]"
                        >
                            <span className="w-2 h-2 rounded-full bg-primary animate-pulse"></span>
                            SECURE VOICE
                        </button>
                    </div>
                </div>

                {/* Messages */}
                <div 
                    ref={chatContainerRef}
                    className="flex-1 overflow-y-auto p-6 space-y-6"
                    style={{ backgroundImage: 'radial-gradient(circle at center, #1e293b 1px, transparent 1px)', backgroundSize: '24px 24px' }}
                >
                    {(currentRoom.messages || []).map((msg) => {
                        const isMe = msg.sender === 'user' && msg.senderName === currentUser.username;
                        const isSystem = msg.sender === 'system';
                        const isAI = msg.sender === 'ai';
                        const content = msg.isEncrypted ? decryptMessage(msg.content) : msg.content;

                        if (isSystem) {
                            return (
                                <div key={msg.id} className="flex justify-center my-4">
                                    <span className="bg-gray-800/80 text-gray-400 text-[10px] px-3 py-1 rounded-full border border-gray-700 font-mono">
                                        SYSTEM: {content}
                                    </span>
                                </div>
                            );
                        }

                        return (
                            <div key={msg.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'} group`}>
                                <div className={`max-w-[70%] ${isMe ? 'items-end' : 'items-start'} flex flex-col`}>
                                    <div className="flex items-center gap-2 mb-1 px-1">
                                        <span className={`text-[10px] font-bold ${isAI ? 'text-purple-400' : isMe ? 'text-primary' : 'text-gray-400'}`}>
                                            {isMe ? 'YOU' : msg.senderName}
                                        </span>
                                        <span className="text-[9px] text-gray-600 font-mono">{new Date(msg.timestamp).toLocaleTimeString()}</span>
                                    </div>
                                    
                                    <div className={`p-3 rounded-lg backdrop-blur-sm border relative ${
                                        isAI ? 'bg-purple-900/20 border-purple-500/30 rounded-tl-none shadow-[0_0_15px_rgba(168,85,247,0.1)]' :
                                        isMe ? 'bg-primary/20 border-primary/30 rounded-tr-none text-white' : 
                                        'bg-gray-800/80 border-gray-700 rounded-tl-none'
                                    }`}>
                                        {msg.type === 'text' && <p className="whitespace-pre-wrap break-words text-sm">{content}</p>}
                                        {msg.type === 'image' && (
                                            <div className="rounded overflow-hidden border border-gray-700/50 mt-1">
                                                <img src={`data:image/png;base64,${content}`} alt="attachment" className="max-w-xs max-h-64 object-cover" />
                                            </div>
                                        )}
                                        {msg.fileName && (
                                            <div className="flex items-center gap-2 text-xs bg-black/20 p-2 rounded mt-2">
                                                <span>📎</span>
                                                <span>{msg.fileName}</span>
                                                <span className="opacity-50">({formatBytes(msg.fileSize || 0)})</span>
                                            </div>
                                        )}
                                    </div>
                                    <div className="px-1 mt-1 text-[9px]">
                                        {getReadReceiptText(msg)}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>

                {/* Input Area */}
                <div className="p-4 bg-gray-800/80 backdrop-blur border-t border-gray-700">
                    <div className="flex gap-4 items-end max-w-5xl mx-auto">
                         <button 
                            onClick={() => fileInputRef.current?.click()}
                            className="p-3 text-gray-400 hover:text-white transition-colors bg-gray-700/50 rounded-lg hover:bg-gray-700"
                         >
                            📎
                         </button>
                         <input 
                            type="file" 
                            ref={fileInputRef} 
                            className="hidden" 
                            onChange={(e) => { if(e.target.files?.[0]) handleSendMessage(e.target.files[0]) }}
                         />
                         
                         <div className="flex-1 bg-gray-900/50 border border-gray-700 rounded-lg focus-within:border-primary/50 focus-within:shadow-[0_0_15px_rgba(59,130,246,0.1)] transition-all flex flex-col">
                             <textarea
                                value={inputText}
                                onChange={(e) => setInputText(e.target.value)}
                                onKeyDown={(e) => {
                                    if(e.key === 'Enter' && !e.shiftKey) {
                                        e.preventDefault();
                                        handleSendMessage();
                                    }
                                }}
                                placeholder={currentUser.role === UserRole.ADMIN ? "Enter command (/ban, /kick, /mute) or message..." : "Type your encrypted message... (@ai to summon bot)"}
                                className="w-full bg-transparent p-3 outline-none text-sm resize-none h-12 max-h-32"
                             />
                             {isLoading && <div className="h-0.5 w-full bg-gray-800 overflow-hidden rounded-b-lg"><div className="h-full bg-purple-500 animate-pulse w-full origin-left animate-[loading_1s_infinite]"></div></div>}
                         </div>

                         <button 
                            onClick={() => handleSendMessage()}
                            disabled={!inputText.trim() && !isLoading}
                            className="p-3 bg-primary hover:bg-primary-dark disabled:opacity-50 disabled:hover:bg-primary text-white rounded-lg transition-all shadow-lg shadow-primary/20 font-bold"
                         >
                            SEND
                         </button>
                    </div>
                </div>
             </>
         )}
      </div>

      <VoiceInterface 
         apiKey={apiKey} 
         isActive={isVoiceActive} 
         onClose={() => setIsVoiceActive(false)} 
      />
    </div>
  );
};

export default App;
