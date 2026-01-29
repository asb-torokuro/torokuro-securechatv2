// firebase.ts

// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getFirestore } from "firebase/firestore";  // 追加（Firestoreを使う場合）

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyAgufDg2Zgj-aWtYcjf-Eb52Yy6h9uxrIc",
  authDomain: "chat-toro-c6ebb.firebaseapp.com",
  projectId: "chat-toro-c6ebb",
  storageBucket: "chat-toro-c6ebb.firebasestorage.app",
  messagingSenderId: "709759071231",
  appId: "1:709759071231:web:57a87857f4166404416dca",
  measurementId: "G-009GFLVM31"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

// ここを追加：他のファイルから使う用に export
export const db = getFirestore(app);
// analytics も他で使いたかったら一応 export してOK
export { analytics };
