# Receipt OCR Camera Demo

スマートフォンのカメラでレシートを撮影し、ブラウザ内で OCR する検証用デモです。

- Live rear-camera preview with `getUserMedia()`
- Capture directly from the video stream
- Japanese OCR with **PaddleOCR.js / PP-OCRv5**
- Client-side WASM inference; captured receipt images are not uploaded to this demo's server
- Bounding-box overlay, text, confidence and raw JSON
- Small heuristic preview for receipt date and total amount
- Mobile-first UI
- GitHub Pages deployment workflow included

## Stack

- Vite
- `@paddleocr/paddleocr-js@0.4.2`
- PP-OCRv5 (`lang: "japan"`)
- ONNX Runtime Web / WASM

The demo intentionally uses a single WASM thread so it works on ordinary GitHub Pages without requiring COOP/COEP headers.

## Local development

```bash
npm install
npm run dev
```

Open the HTTPS development URL from a phone if you want to test `getUserMedia()`. Camera access requires a secure context (`https://`), except for localhost.

## GitHub Pages

A workflow is included at `.github/workflows/deploy-pages.yml`.

1. Create the repository as **Public**.
2. Push the project to `main`.
3. In **Settings → Pages → Build and deployment → Source**, choose **GitHub Actions**.
4. Run/re-run the `Deploy GitHub Pages` workflow if needed.

The deployed URL will normally be:

```text
https://<username>.github.io/<repository>/
```

## Privacy note

OCR inference runs in the browser. The captured image is passed directly from the camera/canvas to PaddleOCR.js; this demo does not POST the receipt image to an application backend. Runtime/model files are fetched from third-party/official hosts as needed.

## License

Demo code: MIT. PaddleOCR/PaddleOCR.js and model licensing remain subject to their upstream licenses (Apache-2.0 at the time this demo was created).
