# Mercador IA V2.2 — correção de edição mobile + motor espacial

Base preservada: V2.1.

## 1. Correção do abre/fecha ao editar mercado, unidade e promoção

O gerenciador de modal foi refeito para mobile:

- não fecha mais por `click` genérico no backdrop;
- exige `pointerdown` e `pointerup` reais no fundo do modal;
- ignora o toque que acabou de abrir o modal por uma janela de segurança;
- ignora arrasto/scroll como comando de fechar;
- remove foco automático agressivo em dispositivos de ponteiro coarse/touch;
- restaura foco no desktop;
- suporta Escape no desktop;
- botões de edição interrompem propagação e encerram a ação imediatamente;
- fechamento explícito por X/Cancelar continua funcionando.

A gravação continua nos mesmos caminhos do Realtime Database. Nenhuma Rule foi alterada.

## 2. Motor de encarte 2.2

A segmentação foi reforçada antes de alterar limiares de confiança:

- cada linha de descrição recebe um domínio espacial em relação aos preços próximos;
- textos claramente pertencentes ao preço vizinho são excluídos;
- descrições são montadas por continuidade vertical/horizontal, não por uma janela ampla fixa;
- dois preços só são agrupados quando existe coerência de produto e/ou sinal local de Clube;
- preço auxiliar do tipo “nesta embalagem a unidade sai por” deixa de virar promoção separada;
- dupla associação divergente pode ser recuperada apenas quando o domínio espacial é forte e o texto é coerente;
- blocos com preços próximos mas produtos diferentes recebem trava específica;
- a tela passa a mostrar associação dupla, domínio do bloco e coerência do bloco;
- duplicatas do mesmo PDF são eliminadas inclusive quando a oferta aparece repetida em páginas diferentes ou duas vezes no mesmo lote de publicação.

A política continua conservadora: validade ausente, preço inválido, contaminação de cabeçalho, preço misturado ao nome, ambiguidade real de tipo de preço ou cluster inconsistente continuam bloqueando publicação automática.

## 3. Arquivos alterados

- `admin.html`
- `css/app.css`
- `js/admin.js`
- `js/pdf-encarte-importer.js`
- `js/utils.js`
- `service-worker.js`
- `version.json`

## 4. Não alterados

- `firebase-database.rules.json`
- `js/firebase-config.js`
- `usuario.html`
- `js/lista-promocoes.js`
- `js/usuario.js`
- `css/user.css`
- Authentication e estrutura do Realtime Database

## 5. Publicação

Substitua somente os arquivos presentes no ZIP nos mesmos caminhos do repositório. Não publique novas Rules por causa desta correção.

Cache PWA: `mercador-ia-shell-v2.2.0`.
Motor PDF: `2.2.0`.
