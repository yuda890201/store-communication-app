function installFirebaseMock() {
  function createMockApp(name, config) {
    const authState = { user: null, listeners: [] };
    const docStore = {}; // "collection/id" -> data
    const docListeners = {};
    let idCounter = 1;

    // テストから「この操作は何も保存していない」ことを検証できるようにする
    function recordWrite(path) {
      window.__firestoreWrites = window.__firestoreWrites || [];
      window.__firestoreWrites.push({ app: name, path });
    }

    function notifyDocListeners(key) {
      (docListeners[key] || []).forEach(cb => cb());
      const parts = key.split('/');
      if (parts.length % 2 === 1) {
        const cgKey = '__cg_' + parts[parts.length - 1];
        (docListeners[cgKey] || []).forEach(cb => cb());
      }
    }

    function makeDocRef(colPath, id) {
      const key = colPath + '/' + id;
      return {
        collection(subName) { return makeColRef(key + '/' + subName); },
        async get() {
          const data = docStore[key];
          return { exists: !!data, id, data: () => data || {} };
        },
        async set(data, opts) {
          recordWrite(key);
          docStore[key] = (opts && opts.merge && docStore[key]) ? { ...docStore[key], ...data } : { ...data };
          notifyDocListeners(key);
          notifyDocListeners(colPath);
        },
        async update(data) {
          recordWrite(key);
          docStore[key] = { ...(docStore[key] || {}), ...data };
          notifyDocListeners(key);
          notifyDocListeners(colPath);
        },
        async delete() {
          recordWrite(key);
          delete docStore[key];
          notifyDocListeners(key);
          notifyDocListeners(colPath);
        },
        onSnapshot(cb) {
          const fn = () => cb({ exists: !!docStore[key], id, data: () => docStore[key] || {} });
          docListeners[key] = docListeners[key] || [];
          docListeners[key].push(fn);
          fn();
          return () => {
            docListeners[key] = (docListeners[key] || []).filter(f => f !== fn);
          };
        }
      };
    }

    // Timestamp（toDate()を持つ値）は時刻として比べる。
    // 素のオブジェクト同士だと全部 "[object Object]" になって並び替えが効かない
    function sortable(v) {
      if (v && typeof v.toDate === 'function') return v.toDate().getTime();
      if (v instanceof Date) return v.getTime();
      return v;
    }

    function makeColRef(colPath) {
      const state = { whereField: null, whereVal: null, orderField: null, orderDir: 'asc', limitN: null };

      // このコレクション直下のドキュメントに where/orderBy/limit を適用して返す
      function collectDocs() {
        let docs = Object.keys(docStore)
          .filter(k => k.startsWith(colPath + '/') && k.split('/').length === colPath.split('/').length + 1)
          .map(k => ({ id: k.split('/').pop(), data: () => docStore[k] }));
        if (state.whereField) docs = docs.filter(d => d.data()[state.whereField] === state.whereVal);
        if (state.orderField) {
          const f = state.orderField;
          docs.sort((a, b) => {
            const av = sortable(a.data()[f]), bv = sortable(b.data()[f]);
            if (av === bv) return 0;
            return (av > bv ? 1 : -1) * (state.orderDir === 'desc' ? -1 : 1);
          });
        }
        if (state.limitN != null) docs = docs.slice(0, state.limitN);
        return docs;
      }

      const ref = {
        doc(id) { return makeDocRef(colPath, id || 'auto' + (idCounter++)); },
        orderBy(field, dir) { state.orderField = field; state.orderDir = dir || 'asc'; return ref; },
        limit(n) { state.limitN = n; return ref; },
        where(field, op, val) { state.whereField = field; state.whereVal = val; return ref; },
        async get() {
          const docs = collectDocs();
          return { docs, empty: docs.length === 0, size: docs.length };
        },
        async add(data) {
          const id = 'auto' + (idCounter++);
          recordWrite(colPath + '/' + id);
          docStore[colPath + '/' + id] = { ...data };
          notifyDocListeners(colPath);
          return { id };
        },
        onSnapshot(cb) {
          // get() と同じ経路を通す。orderBy を無視すると、アプリが
          // 「最新の1件」として何を掴むかがテストと本番でずれる
          const fn = () => {
            const docs = collectDocs();
            cb({ docs, empty: docs.length === 0 });
          };
          docListeners[colPath] = docListeners[colPath] || [];
          docListeners[colPath].push(fn);
          fn();
          return () => {
            docListeners[colPath] = (docListeners[colPath] || []).filter(f => f !== fn);
          };
        }
      };
      return ref;
    }

    function makeCollectionGroupRef(name) {
      const state = { whereField: null, whereVal: null };
      const ref = {
        where(field, op, val) { state.whereField = field; state.whereVal = val; return ref; },
        onSnapshot(cb) {
          const fn = () => {
            let rows = Object.keys(docStore)
              .filter(k => k.split('/').slice(-2, -1)[0] === name)
              .map(k => ({ id: k.split('/').pop(), path: k, data: () => docStore[k] }));
            if (state.whereField) rows = rows.filter(r => r.data()[state.whereField] === state.whereVal);
            cb({
              docs: rows.map(r => {
                const parts = r.path.split('/');
                const docRef = makeDocRef(parts.slice(0, -1).join('/'), r.id);
                docRef.parent = { parent: { id: parts[parts.length - 3] } };
                return { id: r.id, ref: docRef, data: r.data };
              }),
              empty: rows.length === 0
            });
          };
          const key = '__cg_' + name;
          docListeners[key] = docListeners[key] || [];
          docListeners[key].push(fn);
          fn();
          return () => {
            docListeners[key] = (docListeners[key] || []).filter(f => f !== fn);
          };
        }
      };
      return ref;
    }

    return {
      name,
      config,
      firestore() {
        return {
          collection: (colName) => makeColRef(colName),
          collectionGroup: (colName) => makeCollectionGroupRef(colName)
        };
      },
      storage() {
        return {
          ref() {
            return {
              child(path) {
                return {
                  async put(file) {
                    return { ref: { async getDownloadURL() { return 'blob:mock/' + path; } } };
                  }
                };
              }
            };
          }
        };
      },
      auth() {
        return {
          onAuthStateChanged(cb) { authState.listeners.push(cb); cb(authState.user); },
          async signInAnonymously() {
            authState.user = { uid: 'anon-uid', isAnonymous: true, email: null, displayName: null };
            authState.listeners.forEach(cb => cb(authState.user));
          },
          async signInWithEmailAndPassword(email, password) {
            if (window.__mockUsers && window.__mockUsers[email] && window.__mockUsers[email].password === password) {
              authState.user = window.__mockUsers[email].user;
              authState.listeners.forEach(cb => cb(authState.user));
              return { user: authState.user };
            }
            throw new Error('メールアドレスまたはパスワードが違います');
          },
          async createUserWithEmailAndPassword(email, password) {
            const uid = 'staff-' + (idCounter++);
            const user = {
              uid, isAnonymous: false, email, displayName: null,
              async updateProfile(p) { user.displayName = p.displayName; }
            };
            window.__mockUsers = window.__mockUsers || {};
            window.__mockUsers[email] = { password, user };
            authState.user = user;
            authState.listeners.forEach(cb => cb(authState.user));
            return { user };
          },
          async signOut() {
            authState.user = null;
            authState.listeners.forEach(cb => cb(null));
          },
          get currentUser() {
            if (!authState.user) return null;
            const email = authState.user.email;
            return {
              ...authState.user,
              async reauthenticateWithCredential(cred) {
                const record = window.__mockUsers && window.__mockUsers[cred.email];
                if (!record || record.password !== cred.password) {
                  const err = new Error('パスワードが違います');
                  err.code = 'auth/wrong-password';
                  throw err;
                }
              },
              async updatePassword(newPassword) {
                if (window.__mockUsers && window.__mockUsers[email]) {
                  window.__mockUsers[email].password = newPassword;
                }
              }
            };
          }
        };
      }
    };
  }

  // 複数のFirebaseプロジェクト（named app）を独立した状態で保持する。
  // 引数無しの firebase.firestore()/auth() は常にデフォルトアプリに委譲するため、
  // 単一アプリしか使わない既存テストはそのまま動く。
  const DEFAULT_APP_NAME = '[DEFAULT]';
  const appsByName = {};

  window.firebase = {
    get apps() { return Object.values(appsByName); },
    initializeApp(config, name = DEFAULT_APP_NAME) {
      if (appsByName[name]) return appsByName[name];
      const app = createMockApp(name, config);
      appsByName[name] = app;
      return app;
    },
    app(name = DEFAULT_APP_NAME) { return appsByName[name]; },
    firestore() { return window.firebase.app().firestore(); },
    storage() { return window.firebase.app().storage(); },
    auth() { return window.firebase.app().auth(); }
  };
  window.firebase.auth.EmailAuthProvider = {
    credential(email, password) { return { email, password }; }
  };
  window.firebase.firestore.FieldValue = { serverTimestamp: () => ({ __ts: Date.now(), toDate: () => new Date() }) };
}
installFirebaseMock();
