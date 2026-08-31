(function () {
  'use strict';
  const M = window.MercadorIA;
  const { auth } = M;
  const form = document.getElementById('loginForm');
  const loginBtn = document.getElementById('loginBtn');
  const forgotLink = document.getElementById('forgotLink');
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const keepSignedIn = document.getElementById('keepSignedIn');
  const rememberEmail = document.getElementById('rememberEmail');
  const passwordToggle = document.getElementById('passwordToggle');

  const STORAGE_EMAIL = 'mercadorIA:rememberedEmail';
  const STORAGE_KEEP = 'mercadorIA:keepSignedIn';
  const STORAGE_REMEMBER_EMAIL = 'mercadorIA:rememberEmail';

  const savedEmail = localStorage.getItem(STORAGE_EMAIL) || '';
  const savedKeep = localStorage.getItem(STORAGE_KEEP);
  const savedRememberEmail = localStorage.getItem(STORAGE_REMEMBER_EMAIL);
  if (savedEmail) emailInput.value = savedEmail;
  if (savedKeep !== null) keepSignedIn.checked = savedKeep === '1';
  if (savedRememberEmail !== null) rememberEmail.checked = savedRememberEmail === '1';
  if (!rememberEmail.checked) emailInput.value = '';

  const qs = new URLSearchParams(location.search);
  if (qs.get('erro')) M.toast(qs.get('erro'), 'error', 6500);
  if (qs.get('cadastro') === 'pendente') M.toast('Cadastro enviado. O SuperAdmin precisa liberar seu acesso antes do primeiro login.', 'success', 8000);

  passwordToggle?.addEventListener('click', () => {
    const show = passwordInput.type === 'password';
    passwordInput.type = show ? 'text' : 'password';
    passwordToggle.textContent = show ? 'Ocultar' : 'Mostrar';
    passwordToggle.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
    passwordToggle.setAttribute('aria-pressed', show ? 'true' : 'false');
    passwordInput.focus({ preventScroll: true });
  });

  keepSignedIn?.addEventListener('change', () => localStorage.setItem(STORAGE_KEEP, keepSignedIn.checked ? '1' : '0'));
  rememberEmail?.addEventListener('change', () => {
    localStorage.setItem(STORAGE_REMEMBER_EMAIL, rememberEmail.checked ? '1' : '0');
    if (!rememberEmail.checked) localStorage.removeItem(STORAGE_EMAIL);
  });

  auth.onAuthStateChanged(async (user) => {
    if (!user) return;
    try {
      await M.routeAuthenticatedUser(user);
    } catch (error) {
      await auth.signOut().catch(() => {});
      M.toast(error.message, error.code === 'mercador/pending' ? 'warning' : 'error', 7500);
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;
    M.setBusy(loginBtn, true, 'Entrando...');
    try {
      const persistence = keepSignedIn.checked
        ? firebase.auth.Auth.Persistence.LOCAL
        : firebase.auth.Auth.Persistence.SESSION;
      await auth.setPersistence(persistence);
      localStorage.setItem(STORAGE_KEEP, keepSignedIn.checked ? '1' : '0');
      localStorage.setItem(STORAGE_REMEMBER_EMAIL, rememberEmail.checked ? '1' : '0');
      if (rememberEmail.checked) localStorage.setItem(STORAGE_EMAIL, email);
      else localStorage.removeItem(STORAGE_EMAIL);

      const cred = await auth.signInWithEmailAndPassword(email, password);
      // A senha nunca é salva por este código. Quando "Salvar acesso" está ativo,
      // o Firebase persiste a sessão autenticada no dispositivo.
      passwordInput.value = '';
      await M.routeAuthenticatedUser(cred.user);
    } catch (error) {
      const messages = {
        'auth/invalid-credential': 'E-mail ou senha incorretos.',
        'auth/user-disabled': 'Esta conta foi desativada no Firebase Authentication.',
        'auth/too-many-requests': 'Muitas tentativas. Aguarde alguns minutos e tente novamente.'
      };
      if(String(error.code||'').startsWith('mercador/')) await auth.signOut().catch(() => {});
      M.toast(messages[error.code] || error.message || 'Não foi possível entrar.', error.code === 'mercador/pending' ? 'warning' : 'error', 7000);
    } finally {
      M.setBusy(loginBtn, false);
    }
  });

  forgotLink.addEventListener('click', async (event) => {
    event.preventDefault();
    const email = emailInput.value.trim();
    if (!email) {
      M.toast('Digite seu e-mail primeiro para receber a redefinição de senha.', 'warning');
      return;
    }
    try {
      await auth.sendPasswordResetEmail(email);
      M.toast('E-mail de redefinição de senha enviado.', 'success');
    } catch (error) {
      M.toast(error.message || 'Não foi possível enviar o e-mail.', 'error');
    }
  });
})();
