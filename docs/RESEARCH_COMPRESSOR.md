# Fine-tuning de Modelo Compressor — Investigación Futura

> **Estado:** Pendiente de investigación
> **Prioridad:** Baja (RAG + Telegraph English cubren ~86% de reducción de tokens)
> **Última revisión:** Julio 2026

---

## 1. Motivación

Por qué considerar fine-tunear un modelo compressor cuando ya tenemos:

| Técnica | Estado | Reduction |
|---------|--------|-----------|
| Sliding window + summarization | Implementado (Phase 11) | ~60-75% sobre historial |
| Telegraph English | Implementado (Phase 12) | ~20-35% sobre prompt completo |
| RAG con LanceDB | Implementado (Phase 13) | ~46% vs historial completo |
| **Stack combinado (RAG + Telegraph)** | **Implementado** | **~59-86% vs baseline** |
| LLMLingua (subprocess Python) | **Descartado** — riesgo operacional | ~30-50% extra no significativo |
| **Modelo compressor fine-tuneado** | **Investigación futura** | ~40-60% potencial adicional |

**Razón**: Las técnicas actuales son genéricas. Un modelo fine-tuneado en el dominio específico de Alfred (conversaciones técnicas, comandos, rutas de archivos, patrones de DevOps/sistemas) puede lograr mejor compression ratio con menor pérdida semántica que Telegraph English.

---

## 2. Beneficio Potencial Estimado

### 2.1 Projection de tokens por request

Request típico: ~10,000 tokens sin compresión (prompt base + historial completo).

| Fase | Técnica | Tokens/request | Reducción acumulada | Ahorro mensual* |
|------|---------|---------------|---------------------|-----------------|
| Hoy | Sliding window + summary | ~8,500 | — | $0 |
| F12 | + Telegraph English | ~6,000 | ~29% | ~$7.50 |
| F13 | + RAG (reemplaza historial comprimido) | ~4,550 | ~46% | ~$11.85 |
| F12+F13 | RAG + Telegraph combinados | ~3,500 | ~59% | ~$15.05 |
| **Futuro** | **+ Modelo compressor FT** | **~2,000-2,500** | **~71-76%** | **~$18-19** |

*Cálculo: 1,000 requests/mes, Claude Sonnet $3/M input tokens. Embedding cost (OpenAI) ~$0.02/1M tokens ≈ $0.10/mes adicional.

### 2.2 Comparación de técnicas de compresión

| Técnica | Compression ratio | Pérdida semántica | Latencia | Dependencias |
|---------|------------------|-------------------|----------|-------------|
| Telegraph English | ~20-35% | Muy baja | <10ms | 0 |
| LLMLingua (subprocess) | ~30-50% | Baja-media | ~500ms-1s | Python + modelo ~1.2GB |
| Modelo FT 0.5B (Qwen2.5) | ~40-55% | Muy baja (con buen dataset) | ~50-100ms | ONNX/GGUF ~500MB |
| Modelo FT 1B (Llama 3.2) | ~45-60% | Muy baja | ~100-200ms | ONNX/GGUF ~1GB |
| Claude/GPT-4 (compressor API) | ~35-50% | Muy baja | ~1-3s + costo API | API key |

**Veredicto**: LLMLingua no vale la pena — ni en ratio ni en latencia ni en peso. Un modelo fine-tuneado pequeño (0.5B-1B) es la única alternativa que podría superar a Telegraph English con costo operacional manejable.

---

## 3. Enfoque Propuesto

### 3.1 Modelos candidatos

| Modelo | Parámetros | RAM inferencia | Ventaja | Desventaja |
|--------|-----------|---------------|---------|------------|
| Qwen2.5-0.5B | 0.5B | ~1GB | Ultra-ligero, rápido en CPU | Menor capacidad de compresión |
| Llama-3.2-1B | 1B | ~2GB | Buen balance calidad/velocidad | Puede requerir GPU para FT |
| BGE-M3 | 560M | ~1.5GB | Diseñado para embedding + compresión | Ecosistema Python |
| Granite-3.0-2B | 2B | ~4GB | Mayor calidad de compresión | Pesado para CPU |

**Recomendación inicial**: Qwen2.5-0.5B o Llama-3.2-1B — exportar a GGUF para `node-llama-cpp` y eliminar dependencia Python.

### 3.2 Estrategia de fine-tuning

```
Dataset:
  └── Conversaciones reales de Alfred (target: ~10K interacciones)
  └── Cada entrada: [prompt original → prompt comprimido ideal]
  └── Ground-truth generado por Claude/GPT-4 (o revisión manual)

Técnica:
  └── QLoRA (Quantized Low-Rank Adaptation) vía unsloth
  └── Target: el modelo aprende a comprimir sin perder facts clave
  └── Evaluación: BERTScore + human eval + downstream task perf

Export:
  └── Fine-tune → exportar a GGUF → node-llama-cpp para inferencia en Node.js
  └── Reemplazar PromptCompressor.compress() con llamada a modelo
```

### 3.3 Pipeline de entrenamiento

1. Recopilar ~5,000-10,000 pares (original → comprimido) de conversaciones reales
2. Generar ground-truth: Claude/GPT-4 comprime cada prompt; curador humano verifica muestra
3. Fine-tune con QLoRA en T4 16GB (1-3 horas) o RTX 3090 (30-60 min)
4. Evaluar compression ratio, BERTScore, downstream task accuracy
5. Exportar a GGUF, integrar vía `node-llama-cpp`
6. A/B test vs Telegraph English en producción

---

## 4. Evaluación

### 4.1 Métricas

| Métrica | Target | Método |
|---------|--------|--------|
| Compression Ratio | >40% | (tokens_out / tokens_in) |
| BERTScore | >0.95 | Similitud semántica entre original y comprimido |
| Factuality Retention | >98% | ¿El LLM downstream responde igual? (evaluación por pares) |
| Latencia P50 | <150ms | Tiempo de inferencia del modelo compressor |
| Latencia P95 | <300ms | Tiempo de inferencia en el percentil 95 |

### 4.2 Benchmark vs alternativas

| Escenario | Tokens in | Tokens out | Ratio | BERTScore | Latencia |
|-----------|----------|-----------|-------|-----------|----------|
| Sin compresión | 4,000 | 4,000 | 0% | 1.0 | 0ms |
| Telegraph English | 4,000 | 2,800 | 30% | ~0.97 | <10ms |
| LLMLingua (base) | 4,000 | 2,200 | 45% | ~0.93 | ~500ms |
| Modelo FT 0.5B | 4,000 | 2,000 | 50% | ~0.96 | ~100ms |
| Modelo FT 1B | 4,000 | 1,800 | 55% | ~0.97 | ~150ms |

---

## 5. Requisitos Técnicos

### Entrenamiento (offline, una vez)

- GPU: NVIDIA T4 16GB mínimo, RTX 3090/4090 recomendado
- Storage: ~10GB (modelo base + datasets + checkpoints)
- Software: Python 3.10+, `unsloth` o `axolotl`, CUDA 12+
- Dataset: ~5K-10K pares de conversaciones (formato JSONL)
- Tiempo estimado: 1-3h en T4, 30-60min en RTX 3090

### Inferencia (en producción, dentro del contenedor)

- `node-llama-cpp` — binding nativo para Node.js, sin Python
- Modelo GGUF:
  - Qwen2.5-0.5B: ~350MB (cuantizado Q4)
  - Llama-3.2-1B: ~700MB (cuantizado Q4)
- RAM adicional: ~500MB-1.5GB según modelo
- Startup adicional: ~200-500ms para cargar el modelo

### Docker image impact

| Componente | Peso adicional |
|-----------|---------------|
| `@lancedb/lancedb` (ya instalado) | ~15MB |
| `node-llama-cpp` | ~0MB (npm, bindings nativos) |
| Modelo GGUF (Qwen2.5 0.5B Q4) | ~350MB |
| **Total si se implementa** | **~365MB extra** |

Comparación: LLMLingua requeriría ~1.5-2GB adicional (Python + torch + modelo). El modelo FT es **~4-5x más pequeño** y no necesita Python.

---

## 6. Riesgos y Mitigaciones

| Riesgo | Impacto | Probabilidad | Mitigación |
|--------|---------|-------------|------------|
| Dataset insuficiente para fine-tuning | Alto | Media | Data augmentation con LLM; empezar con ~2K pares |
| Modelo no generaliza a nuevos patrones | Medio | Baja | Evaluación continua en producción; rollback a Telegraph |
| Latencia de inferencia degrada experiencia | Medio | Baja | Usar modelo 0.5B, cuantizar a Q4, cachear requests frecuentes |
| Overfitting a usuario específico | Bajo | Media | Dataset diverso, validación cruzada, regularización |
| Mantenimiento del modelo (drift) | Bajo | Baja | Re-fine-tuning trimestral con datos frescos |
| `node-llama-cpp` incompatible con arquitectura | Medio | Baja | Fallback a subprocess llama.cpp; o evaluación de alternative |

---

## 7. Alternativas a Considerar Antes de Fine-Tuning

1. **Telegraph English mejorado**: Iterar sobre reglas lingüísticas manuales. Cero costo operacional. Podría alcanzar ~35-40% con suficiente ingeniería de reglas adicionales (contracciones forzadas, eliminación de pronombres relativos, simplificación de tiempos verbales compuestos).

2. **Compresión vía LLM externo**: Usar el mismo LLM de chat para comprimir el prompt antes de responder (un "pre-call" con un prompt de compresión). Ejemplo: enviar el system prompt a Claude con instrucción "Compress this prompt preserving all key information". Costo: ~1 request extra de ~500 tokens de output. Ratio: ~40-50%. Latencia: +1 LLM call (~2-4s).

3. **Modelo compressor pre-entrenado existente**: Usar `BGE-M3` o `gte-small` como compressor sin fine-tuning. Ratio: ~25-35% (similar a Telegraph). No requiere entrenamiento.

---

## 8. Conclusión y Recomendación

**No es prioritario ahora.** El stack RAG + Telegraph English ya logra ~59-86% de reducción de tokens. Un modelo fine-tuneado agregaría otro ~5-10% de mejora en el mejor caso, con costo significativo de desarrollo, mantenimiento, y peso en el contenedor.

### Cuándo reconsiderar

- [ ] **RAG + Telegraph estabilizados** en producción por >3 meses
- [ ] **Dataset de ~10K+ interacciones** recolectado naturalmente
- [ ] **Caso de uso concreto** donde Telegraph English sea insuficiente (ej: prompts muy largos con pérdida semántica detectable)
- [ ] **Necesidad de reducir aún más el costo** de API (cuando el ahorro marginal justifique la inversión)
- [ ] **Disponibilidad de GPU** para fine-tuning sin costo adicional

---
