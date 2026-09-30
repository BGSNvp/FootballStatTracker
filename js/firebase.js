import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore, doc, collection, setDoc, updateDoc, deleteDoc, addDoc,
  onSnapshot, query, orderBy, getDoc, getDocs, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const app = initializeApp({
  apiKey: "AIzaSyABNKTrQKTiw4U78JGDFAw9eZDZM-3gK2s",
  authDomain: "bgsn-scoreboard.firebaseapp.com",
  projectId: "bgsn-scoreboard",
  storageBucket: "bgsn-scoreboard.firebasestorage.app",
  messagingSenderId: "888144845710",
  appId: "1:888144845710:web:fe848d883391be787622df"
});

export const db = getFirestore(app);
export const GAMES = "footballGames";

export function gameRef(gameId) {
  return doc(db, GAMES, gameId);
}

export function playsRef(gameId) {
  return collection(db, GAMES, gameId, "plays");
}

export function playRef(gameId, playId) {
  return doc(db, GAMES, gameId, "plays", playId);
}

export function watchGame(gameId, onData, onError) {
  return onSnapshot(gameRef(gameId), (snap) => onData(snap.data() || null), onError);
}

export function watchPlays(gameId, onData, onError) {
  return onSnapshot(
    query(playsRef(gameId), orderBy("seq", "asc")),
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError
  );
}

export {
  doc, collection, setDoc, updateDoc, deleteDoc, addDoc,
  onSnapshot, query, orderBy, getDoc, getDocs, serverTimestamp
};
