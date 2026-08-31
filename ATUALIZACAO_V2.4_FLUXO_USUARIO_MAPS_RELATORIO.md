# Mercador IA V2.4 — fluxo do usuário, relatório editável e localização por Google Maps

Data: 10/08/2026

## Base preservada

Esta atualização foi feita sobre a V2.3. Não altera Firebase Config, Authentication, estrutura central da Lista Inteligente, motor PDF, GPS em tempo real do consumidor ou Realtime Database Rules.

## 1. Correção do erro `/markets/undefined/active`

Causa: os registros do Realtime Database são objetos indexados pelo ID da chave. O evento de ativar/desativar recuperava o objeto e tentava usar `objeto.id`, que não existia no valor bruto, gerando `markets/undefined/active`.

Correção:
- o ID da chave vem diretamente de `data-market-toggle`, `data-unit-toggle` e `data-promo-toggle`;
- `entries()` sempre preserva o ID real da chave;
- `toggle()` rejeita IDs vazios/undefined antes de chamar Firebase;
- a alteração de status é feita por `update()` no registro;
- erros de permissão são tratados e exibidos ao administrador, sem Promise não tratada no console.

A mesma proteção foi aplicada a mercados, unidades e promoções.

## 2. Cadastro de unidade somente pelo link do Google Maps

O administrador não digita mais latitude e longitude.

Campos visíveis:
- Mercado
- Nome da unidade
- Link do Google Maps
- Endereço descritivo (opcional)
- Cidade (opcional)
- Estado
- Ativa/inativa

Latitude e longitude continuam existindo internamente porque são necessárias para o cálculo de distância da Lista Inteligente, mas ficam ocultas.

O sistema reconhece coordenadas em URLs completos do Google Maps que contenham:
- coordenadas do Place Details no trecho `!3d...!4d...` (prioridade maior);
- coordenadas no trecho `@lat,lng`;
- parâmetros `q`, `query`, `center`, `destination` ou `ll` contendo latitude/longitude.

### Link curto `maps.app.goo.gl`

Um link curto não contém as coordenadas no próprio texto. Nesta versão, ao detectar esse formato, o Admin orienta a abrir o link no navegador e copiar o URL completo do Google Maps. Resolver qualquer link curto automaticamente, sem expor API key no front-end, exige um serviço de backend/Places em uma evolução posterior.

Cadastros antigos com latitude/longitude continuam compatíveis: ao editar, o sistema gera um URL de Maps a partir das coordenadas já existentes.

## 3. Fluxo mobile da Lista Inteligente

O núcleo original foi preservado: A Comprar, Comprados, Adiados, Relatórios, calculadora, total, finalização e promoções próximas.

Melhorias:
- zoom do navegador não é mais bloqueado;
- nenhum componente principal exige rolagem horizontal;
- resumo da compra com quantidade faltando, no carrinho, adiada e com oferta;
- quatro abas com contadores;
- ações explícitas no item: Lançar preço, Adiar, Voltar à lista e Excluir;
- promoções continuam embutidas no próprio item e antes das ações;
- sugestões de produtos baseadas no histórico das últimas compras;
- ao digitar um produto já existente, o sistema não duplica: leva o usuário ao item existente;
- locais de compra anteriores aparecem como sugestões na finalização;
- botões e campos foram ajustados para toque em celular;
- assinatura visual permanente: `Powered by thIAguinho Soluções Digitais`.

## 4. Relatório / compra finalizada editável com auditoria

Novos relatórios passam a salvar também uma estrutura de itens, além do texto do relatório.

O usuário pode editar uma compra já finalizada:
- local da compra;
- observação;
- produtos;
- quantidade;
- preço unitário.

O total é recalculado automaticamente.

Cada edição grava em `purchase_reports/{uid}/{reportId}/editHistory/{editId}`:
- `editedAt` — data/hora ISO;
- `actorUid` — usuário responsável;
- `action: report_updated`;
- resumo humano das mudanças;
- quantidade de campos/grupos alterados;
- snapshot `before`;
- snapshot `after`.

O relatório também recebe:
- `lastEditedAt`;
- `lastEditedBy`;
- `editCount`.

Na interface, relatórios editados mostram selo `editado Nx`, última edição e histórico das ações.

### Relatórios antigos

Relatórios anteriores à estrutura de itens continuam disponíveis. Para evitar inventar dados que não existiam originalmente, neles o usuário pode editar local e observação, mantendo valores originais.

## 5. Rules do Firebase

NÃO há nova versão de Rules nesta atualização. As Rules atuais já permitem campos adicionais dentro do relatório e `mapsUrl` dentro da unidade, mantendo as validações obrigatórias existentes.

Não substitua nem publique Rules por causa da V2.4.
