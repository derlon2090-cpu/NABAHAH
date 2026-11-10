# تشغيل نباهة مع Ollama

يستخدم `Modelfile` النموذج المحلي الموجود مسبقًا `qwen3:1.7b`. اختير بعد أن تجاوز نموذجا 8B و4B مهلة الاختبار على CPU. لا يحتاج البناء إلى تنزيل نموذج جديد، بينما تبقى النماذج الأكبر مناسبة عند توفر GPU.

```bash
ollama create nabahah-tutor -f ollama/Modelfile
```

إعداد الخادم عندما يعمل الباك إند على الجهاز نفسه:

```ini
AI_API_BASE_URL=http://127.0.0.1:11434/v1
AI_API_KEY=ollama
AI_PROVIDER=ollama
AI_MODEL=nabahah-tutor
AI_STRUCTURED_OUTPUT_MODE=json_schema
AI_DISABLE_REASONING=true
ALLOW_UNGROUNDED_ANSWERS=false
```

`localhost` داخل Vercel أو أي منصة serverless يشير إلى حاوية المنصة، وليس إلى جهاز Ollama الخاص بك. في الإنتاج يجب تشغيل Ollama على مضيف يمكن للباك إند الوصول إليه عبر شبكة خاصة أو HTTPS محمي، وعدم كشف المنفذ `11434` للعامة دون مصادقة وطبقة proxy.

للتوازي على مضيف Ollama نفسه يمكن ضبط:

```bash
OLLAMA_NUM_PARALLEL=4
OLLAMA_MAX_LOADED_MODELS=1
```

## Embeddings

مخطط Neon الحالي يستخدم `vector(1536)`. يرفض `npm run seed:embeddings` أي نموذج يعيد أبعادًا أخرى. لا تضبط `AI_EMBEDDING_DIMENSIONS=1024` مع هذا المخطط؛ يتطلب الانتقال إلى نموذج 1024 migration منفصلة تعيد بناء فهارس HNSW ثم إعادة تضمين جميع الأجزاء.

يمكن إبقاء المحادثة على Ollama وضبط `EMBEDDING_API_BASE_URL` و`EMBEDDING_API_KEY` لمزود منفصل. لإنشاء embeddings بعد ضبط نموذج متوافق مع 1536:

```bash
npm run seed:embeddings
npm run verify:retrieval
```

الدفعة الافتراضية 50 ويمكن تغييرها عبر `EMBEDDING_BATCH_SIZE` حتى حد أقصى 100.
