/* Firebase settings for the admin app (the same project and values as the student app).
 *
 * Fill in the two values from: Firebase console -> Project settings -> General ->
 * "Your apps" -> Web app (the apiKey and projectId fields).
 *
 * The apiKey is NOT a secret: it only identifies the project. What actually protects the data
 * is Firebase Authentication plus the Firestore security rules (see firestore.rules).
 *
 * While these are empty, the Cloud (Firebase) card in Settings shows that cloud publishing is not set up.
 */
window.ENT_FIREBASE = {
  apiKey: 'AIzaSyD9VJySupu5jEzHeiee7QUWPegdLQ5dzpc',
  projectId: 'all-admin-15a16'
};
