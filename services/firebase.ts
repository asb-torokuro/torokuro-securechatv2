import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getFirestore, collection } from "firebase/firestore";  // Firestore用
import { getAuth } from "firebase/auth";  // 認証用 ←追加

const firebaseConfig = {
  apiKey: "AIzaSyAgufDg2Zgj-aWtYcjf-Eb52Yy6h9uxrIc",
  authDomain: "chat-toro-c6ebb.firebaseapp.com",
  projectId: "chat-toro-c6ebb",
  storageBucket: "chat-toro-c6ebb.firebasestorage.app",
  messagingSenderId: "709759071231",
  appId: "1:709759071231:web:57a87857f4166404416dca",
  measurementId: "G-009GFLVM31"
};

const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

// ここ追加
export const db = getFirestore(app);
export const auth = getAuth(app);
