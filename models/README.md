# Comic text and bubble detector

`comic-text-bubble-detector-int8.onnx` comes from
`ogkalu/comic-text-and-bubble-detector` on Hugging Face.

- Source: https://huggingface.co/ogkalu/comic-text-and-bubble-detector
- License: Apache-2.0
- File: `detector_int8.onnx`

The translator uses the model only to locate text blocks and speech bubbles for
single-pass patch-atlas image editing.

For Japanese pages, Patch Atlas also uses the Apache-2.0 `manga-ocr` package
and `kha-white/manga-ocr-base` model to match each detected crop to its source
text before assigning a translation. Install it with:

```powershell
python -m pip install manga-ocr==0.1.15
```

The OCR model is downloaded to the Hugging Face cache on first use. This is a
local recognition pass and does not add OpenAI API calls.
