
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getAnalytics } from "firebase/analytics";

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
export const auth = getAuth(app);
export const db = getFirestore(app);

// Initialize Analytics only in browser
if (typeof window !== 'undefined') {
  try {
    getAnalytics(app);
  } catch (e) {
    console.warn("Firebase Analytics init failed", e);
  }
}
