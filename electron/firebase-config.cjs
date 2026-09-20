/**
 * Firebase project the desktop app checks licences against.
 *
 * The apiKey is not a secret — Firebase web keys identify a project, they do
 * not authorise anything. What protects the licence records is Firestore rules
 * plus Anonymous Authentication; see admin-panel/firestore.rules.
 */

module.exports = {
  apiKey: 'AIzaSyBZoy27CkEtQo3hYESMWoZGHmjKvKkgrWs',
  authDomain: 'dt-hotel-mangemnet.firebaseapp.com',
  projectId: 'dt-hotel-mangemnet',
  storageBucket: 'dt-hotel-mangemnet.firebasestorage.app',
  messagingSenderId: '707115971984',
  appId: '1:707115971984:web:bf9bc7aa5c117006c7af15',

  /** Firestore collection holding licence documents. */
  licencesCollection: 'licences'
};
