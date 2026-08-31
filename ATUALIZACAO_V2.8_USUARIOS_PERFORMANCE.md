# Mercador IA V2.8 — usuários, aprovação e performance da lista

## Escopo
Atualização cumulativa sobre a V2.7, preservando Admin, importador PDF, GPS em tempo real, promoções próximas, relatórios editáveis e sincronização colaborativa da lista.

## Gestão de usuários
- Cadastro público cria perfil `user` com `status: pending`.
- WhatsApp/celular é obrigatório no cadastro público.
- SuperAdmin recebe os pendentes no topo do painel de Usuários.
- Ações: Editar, Aprovar, Rejeitar, Bloquear/Ativar e Excluir acesso/dados do aplicativo.
- E-mail de login fica somente leitura no editor, para não divergir do Firebase Authentication.
- Nome, WhatsApp, e-mail de contato e observação interna podem ser editados.
- Aprovação inicial cria `user_settings/{uid}/radiusKm = 5` somente para cadastro público ainda não aprovado.
- Exclusão de consumidor remove `shopping_lists`, `user_settings` e `purchase_reports` e mantém um tombstone `status: deleted` no perfil para negar acesso e preservar auditoria.
- A conta correspondente no Firebase Authentication não pode ser apagada por outro usuário diretamente do navegador; exclusão física do Auth exige backend com Firebase Admin SDK.

## Lista: troca de abas e tempo real
- Corrigido o clique dos botões de aba: agora o toque no texto/contador dentro do botão também responde (`closest('.tab-btn')`).
- Removida a pré-renderização das abas ocultas.
- Removido o listener permanente `value` da lista.
- Após uma leitura canônica inicial, sincronização passa a usar `child_added`, `child_changed` e `child_removed`.
- Uma alteração feita em outro aparelho recebe somente o item alterado e marca somente as abas afetadas como sujas.
- Confirmações do Firebase idênticas ao estado otimista local não reconstruem o DOM.
- A sincronização colaborativa do mesmo UID continua em tempo real.
- Links `?tab=faltando`, `?tab=comprados`, `?tab=adiados` e `?tab=relatorios` agora abrem a aba correta.

## Dashboard do usuário
- Removida a repetição “Abrir minha lista” + “Minha lista”.
- Indicadores A Comprar, Comprados, Adiados e Total são atalhos diretos para a aba correspondente.
- Mantido um único acesso específico a Relatórios.
- Cache local da lista é exibido antes da confirmação do Firebase para o painel aparecer mais rápido.

## Firebase Rules
As Rules mudaram nesta versão.

Motivo principal: o cadastro público agora precisa criar `users/{uid}` com `status: pending`. As regras permitem somente a criação do próprio perfil com role `user`, status `pending`, e-mail igual ao token e telefone válido. O usuário não consegue se autoaprovar depois.

Statuses válidos: `pending`, `active`, `blocked`, `rejected`, `deleted`.

Publique `firebase-database.rules.json` no Firebase Realtime Database junto com esta versão.
