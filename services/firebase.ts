// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";

import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// Firebase Console (https://console.firebase.google.com/) から取得した設定をここに貼り付けてください
const firebaseConfig = {
  apiKey: "AIzaSyAgufDg2Zgj-aWtYcjf-Eb52Yy6h9uxrIc", 
  authDomain: "chat-toro-c6ebb.firebaseapp.com",
  projectId: "chat-toro-c6ebb",
  storageBucket: "chat-toro-c6ebb.firebasestorage.app",
  messagingSenderId: "709759071231",
  appId: "1:709759071231:web:57a87857f4166404416dca"
  measurementId: "G-009GFLVM31"
};

// 設定が正しく行われているかチェックするヘルパー
export const isFirebaseConfigured = () => {
  return firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("YOUR_");
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
