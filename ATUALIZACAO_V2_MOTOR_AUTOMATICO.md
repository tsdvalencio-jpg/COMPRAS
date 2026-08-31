# Mercador IA V2.0 — Motor automático de encartes

Base: V1.5.

## O que muda

O importador de PDF deixa de exigir revisão item por item. Cada candidato é submetido a:

- duas associações espaciais independentes entre descrição e preço;
- detecção de validade do encarte;
- identificação de embalagem/categoria quando disponível;
- tratamento de preço único e preço Clube/programa;
- verificações de consistência e contaminação de texto;
- pontuação de confiança e lista de evidências/riscos;
- prevenção de duplicação do mesmo produto/página/preço/hash.

## Política padrão

`Profissional · 98%`.

Um item só entra na fila automática se ultrapassar o limite configurado **e** não possuir trava crítica. Casos ambíguos são separados em Revisão.

O administrador pode usar 99%, 98% ou 97%. O limite não remove as travas críticas.

## Publicação

Com `Publicar automaticamente os casos seguros` marcado, o sistema:

1. lê o PDF;
2. classifica as ofertas;
3. publica as ofertas automáticas seguras;
4. mostra apenas as exceções restantes para revisão.

Cada promoção automática grava `verificationMode: automatic`, confiança, evidências, riscos, versão do motor, hash e página de origem.

## Firebase

Não há mudança de estrutura obrigatória nem de Rules nesta atualização. Os novos campos são metadados adicionais permitidos pelas Rules atuais de `promotions`.
