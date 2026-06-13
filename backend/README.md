# Online Booking Backend

Express backend for Firebase-authenticated Zenopay payments.

## Local Development

1. Copy `backend/.env.example` to `backend/.env`.
2. Fill in Firebase and Zenopay values.
3. Start the server:

```bash
npm install
npm start
```

The local server defaults to `http://localhost:3000`.

## Render Deployment

This repository includes a root `render.yaml` blueprint. In Render:

1. Create a new Blueprint from this Git repository.
2. Render will use `backend` as the service root directory.
3. Add the secret environment variables requested by the blueprint.
4. Deploy the service.
5. Copy the generated Render URL and update `ZENOPAY_WEBHOOK_URL` to:

```text
https://YOUR_RENDER_SERVICE.onrender.com/zenopay-webhook?token=YOUR_WEBHOOK_SECRET
```

Use the same value for `YOUR_WEBHOOK_SECRET` and `ZENOPAY_WEBHOOK_SECRET`.

For Firebase Admin, set `FIREBASE_SERVICE_ACCOUNT_BASE64` in Render:

1. In Firebase Console, open Project settings > Service accounts.
2. Generate a new private key and download the JSON file.
3. Base64-encode that JSON file:

```bash
base64 -w 0 path/to/service-account.json
```

4. Paste the output into Render's `FIREBASE_SERVICE_ACCOUNT_BASE64` environment variable.

If your `base64` command does not support `-w`, use:

```bash
base64 path/to/service-account.json | tr -d '\n'
```

For the Flutter app, build or run with the deployed backend URL:

```bash
flutter run --dart-define=BACKEND_URL=https://YOUR_RENDER_SERVICE.onrender.com
```
