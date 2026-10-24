# Expo Go 版（EAS Update で配信）

iPhone で指置きなしで叩けるように、Web 版を Expo Go の中で動かすためのアプリ。
本体は `public/expo/App.js`（Web 版をそのまま表示し、プレイ中だけアプリ側で指を受け取って Web 版に渡す）。

- `main` に push すると、GitHub Actions（`.github/workflows/expo-update.yml`）が EAS Update で配信する
- GitHub の Secrets に `EXPO_TOKEN`（expo.dev のアクセストークン）が必要
- 開き方: Expo Go に同じアカウントでログイン → ホームの Projects の TJAtelier。または Actions の結果に出るリンク
