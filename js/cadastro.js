(function () {
  'use strict';
  const M = window.MercadorIA;
  const { auth, db, serverTimestamp } = M;
  const form = document.getElementById('registerForm');
  const btn = document.getElementById('registerBtn');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = document.getElementById('name').value.trim();
    const email = document.getElementById('email').value.trim().toLowerCase();
    const phone = document.getElementById('phone').value.trim();
    const password = document.getElementById('password').value;
    const confirm = document.getElementById('confirmPassword').value;

    if (password !== confirm) {
      M.toast('As senhas não são iguais.', 'warning');
      return;
    }
    if (name.length < 2) {
      M.toast('Informe seu nome.', 'warning');
      return;
    }

    if (phone.replace(/\D/g,'').length < 8) { M.toast('Informe um telefone/WhatsApp válido para contato.', 'warning'); return; }

    M.setBusy(btn, true, 'Enviando cadastro...');
    try {
      const credential = await auth.createUserWithEmailAndPassword(email, password);
      const uid = credential.user.uid;
      await db.ref(`users/${uid}`).set({
        name,
        email,
        contactEmail: email,
        phone,
        role: 'user',
        status: 'pending',
        registrationSource: 'public',
        approvalRequestedAt: serverTimestamp,
        createdAt: serverTimestamp,
        createdBy: uid,
        updatedAt: serverTimestamp
      });
      await auth.signOut();
      M.toast('Cadastro enviado. Aguarde a liberação do SuperAdmin.', 'success', 7000);
      location.replace('./index.html?cadastro=pendente');
    } catch (error) {
      const messages = {
        'auth/email-already-in-use': 'Já existe uma conta com este e-mail.',
        'auth/invalid-email': 'E-mail inválido.',
        'auth/weak-password': 'A senha precisa ter pelo menos 6 caracteres.'
      };
      M.toast(messages[error.code] || error.message || 'Não foi possível criar a conta.', 'error', 6500);
    } finally {
      M.setBusy(btn, false);
    }
  });
})();
