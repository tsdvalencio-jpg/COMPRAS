# Instalação Firebase — Mercador IA V1

## 1. Realtime Database

No Firebase Console do projeto `mercadoria-37c2e`:

1. Abra **Realtime Database**.
2. Entre na aba **Rules**.
3. Abra neste ZIP o arquivo `firebase-database.rules.json`.
4. Copie o conteúdo inteiro.
5. Cole no editor das Rules.
6. Clique em **Publish**.

Como este Firebase foi criado para o Mercador IA, estas regras são a base oficial da V1.

## 2. Authentication

1. Abra **Authentication**.
2. **Sign-in method / Método de login**.
3. Mantenha **E-mail/senha** ativado.
4. Desative **Anônimo**.
5. Em **Settings / Configurações > Authorized domains**, adicione/confirme `tsdvalencio-jpg.github.io`.

## 3. Conta Master

A conta já existente deve possuir exatamente este UID no Authentication:

`Ah16jHtjZTgSVBzgL759FnQl5W73`

Ao entrar pela primeira vez, o front-end grava/atualiza o perfil Master em `users/{uid}` porque as Rules autorizam especificamente esse UID.

## 4. Não criar preços direto no JSON do banco

Use o painel Admin > Promoções. Ele grava os metadados de conferência e origem necessários para o motor inteligente.
