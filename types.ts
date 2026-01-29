export enum UserRole {
  ADMIN = 'ADMIN',
  USER = 'USER',
}

export interface User {
  id: string;
  username: string;
  passwordHash: string; // Simulated hash
  role: UserRole;
  createdAt: number;
  friends: string[]; // List of Friend User IDs
  friendRequests: string[]; // List of User IDs who sent a request
  lastLogin?: number; // Timestamp of last login
  loginHistory?: number[]; // Array of past login timestamps
}

export interface Message {
  id: string;
  sender: 'user' | 'ai' | 'system';
  senderName?: string; // To display who sent it in group chats
  content: string; // Encrypted string in storage, decrypted in UI
  timestamp: number;
  type: 'text' | 'image' | 'video' | 'audio' | 'file';
  fileName?: string;
  fileSize?: number;
  isEncrypted: boolean;
  readBy: string[]; // Array of User IDs who have read this message
}

export interface Room {
  id: string; // 7-digit random number or UUID for private
  name: string; // Room name
  type: 'group' | 'private';
  creatorId: string;
  createdAt: number;
  participants: string[]; // List of User IDs
  messages: Message[];
  bannedUsers: string[]; // IDs of banned users (for this room)
  mutedUsers: string[]; // IDs of muted users (for this room)
}

export interface SystemLog {
  id: string;
  timestamp: number;
  event: string;
  details: string;
  level: 'info' | 'warning' | 'alert';
}

export interface FileMeta {
  name: string;
  size: number;
  type: string;
  dataUrl?: string; // Only for small previews
}