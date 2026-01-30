
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getFirestore } from "firebase/firestore";  // v9形式
import { getAuth } from "firebase/auth";          // v9形式

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

// v9形式で export
export const db = getFirestore(app);
export const auth = getAuth(app);
export { analytics };
