# MERCADOR IA — V1.2

> **Correção importante:** `usuario.html` agora usa diretamente o código funcional da Lista Inteligente original enviada pelo usuário (calculadora, A Comprar, Comprados, Adiados, Relatórios, finalização e histórico), adaptado apenas ao Firebase novo e acrescido do módulo de promoções geolocalizadas.

Plataforma SaaS/PWA de lista inteligente com promoções verificadas por geolocalização.

**Projeto Firebase:** `mercadoria-37c2e`  
**GitHub:** `tsdvalencio-jpg/mercador_IA`  
**Front-end:** GitHub Pages  
**Banco:** Firebase Realtime Database  
**Login:** Firebase Authentication — E-mail/senha

## Administrador Master inicial

- UID: `Ah16jHtjZTgSVBzgL759FnQl5W73`
- E-mail: `tsd.valencio@gmail.com`
- Papel criado/garantido no primeiro login: `superadmin`

A autorização administrativa real é protegida pelas regras do Realtime Database e pelo UID autenticado. Não depende apenas de botões escondidos no navegador.

## Arquivos principais

- `index.html` — login
- `cadastro.html` — cadastro público de consumidor
- `admin.html` — painel administrativo
- `usuario.html` — painel do consumidor com a Lista Inteligente completa: A Comprar, Comprados, Adiados, Relatórios, calculadora e Ofertas
- `firebase-database.rules.json` — regras completas desta V1
- `js/firebase-config.js` — Firebase oficial deste projeto
- `js/admin.js` — usuários, mercados, unidades, promoções, inbox e auditoria
- `js/smart-matcher.js` — correspondência inteligente entre item e promoção
- `service-worker.js` + `manifest.webmanifest` — PWA

## Antes de testar

### 1. Authentication

No Firebase Console > Authentication > Método de login:

- E-mail/senha: **ATIVADO**
- Anônimo: **DESATIVADO**

Em Authentication > Settings > Authorized domains, confirme que o domínio do GitHub Pages está autorizado:

`tsdvalencio-jpg.github.io`

### 2. Realtime Database Rules

Abra Firebase Console > Realtime Database > Rules.

Substitua as regras do projeto NOVO pelas regras de `firebase-database.rules.json` e publique.

Estas regras pertencem exclusivamente ao Firebase novo `mercadoria-37c2e`.

### 3. Primeiro login do Master

Acesse `index.html` e entre com a conta do UID master já criada no Authentication.

No primeiro login, o sistema garante o perfil:

```text
users/Ah16jHtjZTgSVBzgL759FnQl5W73
  role: superadmin
  status: active
```

A senha não está no código nem no banco de dados.

## Fluxo de teste real

1. Login Master.
2. Admin > Mercados > cadastrar um mercado real.
3. Admin > Unidades > cadastrar endereço + latitude/longitude reais. O botão "Usar minha localização atual" pode preencher as coordenadas quando o administrador estiver fisicamente na loja/local desejado.
4. Admin > Promoções > cadastrar produto, preço real, validade e origem.
5. Marcar "Confirmei o preço e a validade desta oferta".
6. Admin > Usuários > criar um consumidor ou usar `cadastro.html`.
7. Entrar como consumidor.
8. Na aba **A Comprar**, adicionar na lista, por exemplo, `Chocolate`.
9. Usar a calculadora inferior normalmente durante a compra; itens pagos migram para **Comprados**, e a compra pode gerar **Relatórios** como na lista original.
10. Na aba **🔥 Ofertas**, autorizar a localização e escolher o raio.
11. Se houver promoção compatível em unidade dentro do raio, ela aparece automaticamente sem apagar nem substituir o fluxo tradicional da lista.


## Lista do consumidor preservada

A V1.1 corrige a interface do consumidor para manter o fluxo completo da Lista Inteligente original usada como referência pelo projeto:

- `A Comprar`
- `Comprados`
- `Adiados`
- `Relatórios`
- total da compra no cabeçalho
- calculadora inferior recolhível
- quantidade × preço e total por item
- finalização da compra e histórico em `purchase_reports/{uid}`
- nova aba `🔥 Ofertas`, acrescentada sem retirar as rotinas anteriores

A inteligência de promoções atua sobre os itens em `A Comprar`; ela não substitui a lista tradicional.

## Valores reais

A V1 **não possui seed de promoções fictícias**.

Uma promoção só entra no motor quando:

- `active === true`
- `verified === true`
- horário atual está entre `startAt` e `endAt`
- mercado está ativo
- unidade está ativa
- unidade está dentro do raio do usuário
- produto corresponde ao item da lista com confiança mínima

O formulário administrativo exige também `sourceType` e `sourceReference` para rastrear a origem do valor.

## Privacidade de localização

Nesta V1, o consumidor usa `navigator.geolocation.getCurrentPosition()`.

A latitude/longitude do consumidor:

- fica em memória no navegador;
- é usada para calcular Haversine até as unidades;
- não é gravada no Realtime Database;
- é descartada ao fechar/recarregar a sessão.

As coordenadas das unidades dos mercados são persistidas porque fazem parte do cadastro comercial.

## Estrutura do Realtime Database

```text
users/{uid}
shopping_lists/{uid}/{itemId}
purchase_reports/{uid}/{reportId}
user_settings/{uid}
markets/{marketId}
market_units/{unitId}
promotions/{promoId}
promotion_inbox/{messageId}
market_users/{marketId}/{uid}      # preparado para fase comercial
audit_logs/{logId}
```

## Perfis previstos

- `superadmin`
- `admin`
- `user`
- `market_admin` — reservado para fase do painel dos mercados
- `market_operator` — reservado para fase do painel dos mercados

## Responsividade

O layout usa CSS Grid/Flex, `clamp()`, grades automáticas e breakpoints para adaptação automática.

- Desktop: sidebar administrativa e múltiplas colunas.
- Tablet: grades reduzidas.
- Celular: navegação administrativa inferior, formulários em uma coluna, cards fluidos e botões adaptados.
- Sem largura fixa que force rolagem horizontal das telas principais.

## Segurança implementada

- Dados privados de lista separados por UID.
- Consumidor não pode alterar o próprio `role` ou `status` pelas regras.
- Master é reconhecido pelo UID autenticado.
- Admin cria usuário no Authentication por uma instância Firebase secundária, sem encerrar a sessão administrativa.
- Senhas nunca são salvas no Realtime Database.
- Promoções exigem vínculo consistente mercado/unidade nas Rules.
- Usuário bloqueado perde acesso aos dados operacionais.
- Operações administrativas relevantes geram `audit_logs`.
- Dados renderizados são escapados antes de entrar em HTML dinâmico.

## GitHub Pages

O projeto usa caminhos relativos (`./`) e está preparado para funcionar em:

`https://tsdvalencio-jpg.github.io/mercador_IA/`

Depois de subir os arquivos na branch usada pelo Pages, aguarde o deploy e abra a URL acima.

## Próximas fases já previstas pela arquitetura

1. Painel comercial `market_admin` / `market_operator`.
2. Bot servidor para WhatsApp alimentando `promotion_inbox`.
3. Catálogo universal de produtos/GTIN.
4. Histórico real de preços para detectar falsa promoção.
5. Notificações push.
6. APK Android para geolocalização/alertas em segundo plano quando houver justificativa de produto e consentimento do usuário.

---

Powered by **thIAguinho Soluções Digitais**.
