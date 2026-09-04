# Como deixar 100% offline

O código usa WebLLM e não faz chamadas de inferência para uma API. WebLLM executa o modelo no navegador via WebGPU e suporta Web Workers. A documentação oficial mostra `CreateMLCEngine()` e cache local dos artefatos.

Para uma distribuição realmente sem rede:

1. Execute `npm install` uma vez em uma máquina conectada.
2. Faça o primeiro carregamento do modelo nessa máquina/dispositivo.
3. Empacote/cacheie os artefatos do modelo junto com o aplicativo ou implemente um AppConfig/model registry local.
4. Não use CDN.
5. Em Android, prefira a variante nativa llama.cpp para produção.

O projeto já tem o contrato de decisão; trocar o runtime não muda o simulador.
