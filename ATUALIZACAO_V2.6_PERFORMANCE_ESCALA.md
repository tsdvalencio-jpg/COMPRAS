# Mercador IA V2.6 — Performance, escala e fluxo leve do usuário

Data: 10/08/2026
Base: atualização cumulativa para quem está na V2.4 e ainda não publicou a V2.5.

## Objetivo

Reduzir latência percebida na Lista Inteligente, eliminar leituras universais desnecessárias do Realtime Database, diminuir reconstruções de DOM, reduzir gravações repetitivas e preparar o fluxo para crescimento de usuários e mercados sem remover funcionalidades.

## Mudanças no usuário

### Lista instantânea e sincronização em segundo plano
- A última lista conhecida fica em cache local por UID e é exibida imediatamente ao abrir.
- O Firebase continua sendo a fonte de verdade e reconcilia a lista em tempo real.
- Quando uma escrita otimista já deixou a tela igual ao estado confirmado pelo Firebase, a confirmação não provoca outra reconstrução visual.

### Abas A Comprar / Comprados / Adiados
- Somente a aba visível é renderizada no caminho crítico.
- As abas escondidas são pré-renderizadas quando o navegador está ocioso.
- Trocar de aba não dispara leitura no Firebase.
- O estado de rolagem de cada aba é preservado.

### Relatórios
- Foi removido o listener permanente de todo o histórico.
- Relatórios só são carregados quando o usuário abre a aba Relatórios.
- Primeira página: até 50 relatórios recentes.
- Botão “Carregar relatórios mais antigos” busca mais 50 por vez.
- Edição, auditoria, exclusão e relatórios antigos continuam disponíveis.

### Escritas
- Adicionar, adiar, restaurar, excluir e lançar preço atualizam a tela primeiro e sincronizam em seguida, com rollback em caso de erro.
- Finalizar compra usa uma única atualização multipath: relatório + limpeza/reorganização da lista são confirmados atomicamente pelo Realtime Database.
- `lastLoginAt` foi limitado a no máximo uma atualização a cada 30 minutos por aparelho/sessão, em vez de gravar novamente a cada troca de página.

## Promoções e localização

### Antes
O módulo de promoções mantinha listeners separados para:
- shopping_lists/{uid}
- markets inteiro
- market_units inteiro
- promotions inteiro

Isso duplicava a lista já acompanhada pela tela principal e fazia todo usuário receber o catálogo global de promoções.

### Agora
- O módulo de promoções não cria um segundo listener da lista.
- Recebe a lista já mantida pela tela através de evento local.
- `geo_catalog` contém somente dados mínimos de unidades ativas: mercado, unidade, GPS e endereço.
- `promotion_live/{unitId}` contém somente os campos necessários das promoções válidas.
- O usuário acompanha promoções somente das unidades dentro do raio + margem técnica.
- Se a unidade sai da região próxima, o listener daquela unidade é removido.
- Há fallback temporário para a estrutura antiga durante a migração.

### GPS
- `watchPosition` continua em tempo real.
- O status do GPS pode atualizar a cada fix, mas a operação pesada de recalcular unidades/assinaturas só roda quando o usuário se desloca aproximadamente 70 m ou após 20 s.
- A localização continua em memória e não é gravada no Realtime Database.

## Índices derivados mantidos pelo Admin

Novos nós:

```
geo_catalog/
  {unitId}/
    marketId
    marketName
    unitName
    lat
    lng
    address
    city
    state
    mapsUrl
    active

promotion_live/
  {unitId}/
    {promoId}/
      campos compactos necessários ao consumidor
```

Salvar/editar/ativar/desativar/excluir mercados, unidades ou promoções mantém esses índices automaticamente.

Para dados que já existiam antes da V2.6, o SuperAdmin deve executar uma vez:

**Promoções → ⚡ Otimizar dados dos usuários**

A ação reconstrói os dois índices em uma operação.

## Rules V2.6

As Rules mudaram e precisam ser publicadas.

Foram acrescentados:
- permissões para `geo_catalog`;
- permissões para `promotion_live`;
- `.indexOn` em `markets.active`;
- `.indexOn` em `market_units.active` e `market_units.marketId`;
- `.indexOn` em `promotions.unitId`, `promotions.active`, `promotions.endAt`;
- `.indexOn` em `promotion_live/{unitId}.endAt`.

A V2.6 também inclui as regras da V2.5 de exclusão definitiva apenas pelo SuperAdmin.

## PWA

O Service Worker deixou de pré-baixar para todo consumidor:
- admin.html
- admin.css
- admin.js
- pdf-encarte-importer.js
- usuario.js legado não utilizado pela tela atual

Esses arquivos continuam funcionando no Admin, mas entram no cache somente se o Admin for acessado.

No conjunto atual de arquivos, o shell inicial pré-cacheado caiu aproximadamente de 325,5 KiB para 168,2 KiB (cerca de 48% menor, sem contar Firebase CDN).

## Fluxo de instalação desta versão

1. Substituir no GitHub os arquivos do ZIP V2.6.
2. No Firebase Realtime Database → Rules, substituir pelas Rules V2.6 incluídas no pacote e publicar.
3. Abrir o SuperAdmin.
4. Entrar em Promoções.
5. Clicar uma vez em **⚡ Otimizar dados dos usuários**.
6. Testar a lista em um usuário comum.
7. No Firebase Console, acompanhar Usage/Profiler durante os testes de carga reais.

## O que não foi sacrificado

- Lista original funcional.
- Calculadora.
- A Comprar / Comprados / Adiados.
- Relatórios e edição auditada.
- GPS em tempo real.
- Promoções por proximidade.
- Login persistente da V2.5.
- Exclusão segura de mercado/unidade/promoção da V2.5.
- Importador de PDF e fila de revisão.
- Assinatura “Powered by thIAguinho Soluções Digitais”.
