# Mercador IA V1.1 — Correção da Lista do Usuário

Esta versão corrige a V1 anterior, que havia criado uma lista simplificada no painel do consumidor.

A interface `usuario.html` agora reaproveita o fluxo completo da Lista Inteligente original enviada como referência, migrado para o Firebase novo `mercadoria-37c2e` e isolado por UID.

## Fluxos preservados/restaurados

- Sua Compra
- total no cabeçalho
- adicionar item
- A Comprar
- Comprados
- Adiados
- Relatórios
- calculadora inferior recolhível
- seleção do item para lançar preço
- quantidade x preço
- retorno de item comprado para A Comprar
- adiar item
- finalizar compra
- informar local da compra
- salvar relatório em `purchase_reports/{uid}`
- excluir relatório
- baixar/imprimir relatório

## Inteligência acrescentada

Foi adicionada a aba `🔥 Ofertas`, sem substituir os fluxos anteriores.

Ela usa:

- itens em `A Comprar` (`status = faltando`)
- `markets`
- `market_units`
- `promotions`
- localização atual do aparelho
- raio salvo em `user_settings/{uid}/radiusKm`

A localização do consumidor continua apenas em memória nesta versão.

## Regras

`firebase-database.rules.json` foi atualizado para aceitar a estrutura completa da lista original e o novo caminho `purchase_reports/{uid}`.

## Compatibilidade

Se algum item tiver sido criado pela V1 simplificada usando os campos `name`, `quantity`, `pending/bought`, a V1.1 faz migração automática para o formato completo `nome`, `quantidade`, `preco`, `faltando/comprado`.
