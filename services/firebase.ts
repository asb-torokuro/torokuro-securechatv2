// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

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
