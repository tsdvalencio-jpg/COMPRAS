# Mercador IA V1.2 — Lista Inteligente original integrada

Esta versão corrige a V1/V1.1: o painel do usuário passou a usar diretamente como base o `index.html` da Lista Inteligente original enviado no ZIP `thIAguinho_Solucoes_IA-main.zip`.

## Núcleo preservado
- Sua Compra e total no cabeçalho.
- Campo Adicionar item e botão +.
- Botão verde Finalizar Compra / Gerar Relatório.
- Abas A Comprar, Comprados, Adiados e Relatórios.
- Emojis automáticos por produto.
- Seleção do item.
- Calculadora completa recolhível: 0–9, decimal, ×, −, +, ÷ e C.
- Registro de quantidade e preço no item selecionado.
- Totalização dos itens comprados.
- Finalização da compra com Local da Compra.
- Geração/visualização/download/impressão do relatório.
- Histórico em `purchase_reports/{uid}` e exclusão de relatório.
- Persistência em tempo real em `shopping_lists/{uid}`.

## Alterações necessárias para o Mercador IA
- Firebase trocado para `mercadoria-37c2e` pelo `js/firebase-config.js`.
- Perfil/bloqueio usa `users/{uid}` do novo SaaS.
- Dados permanecem isolados por UID.
- Acrescentado, sem substituir a lista, o módulo `js/lista-promocoes.js`.
- O módulo de promoções usa localização somente após ação do usuário e cruza somente promoções ativas, verificadas e dentro da validade/raio.
- Nenhum preço fictício foi embutido.
- Responsividade desktop acrescentada sem mudar o layout original de celular.
