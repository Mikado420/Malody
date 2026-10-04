/**
 * Malody Web Editor を Expo Go の中で動かすためのアプリ（Expo Snack 用の 1 ファイル）
 *
 * iPhone の Safari（WebKit）は、両手交互で速く叩いて「指が 1 本も触れていない瞬間」に
 * 次の指が触れると、そのタッチをページに届けないことがある。
 * そこでテストプレイ中だけ、Web 版の上に透明な層を重ね、アプリ（React Native）の仕組みで指を受け取って
 * Web 版の window.__nativeHit(x, y, 時刻) に渡す。エディタを使うときは層を外す。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { WebView } from 'react-native-webview';
import { StatusBar } from 'expo-status-bar';
import * as ScreenOrientation from 'expo-screen-orientation';

const URL = 'https://mikado420.github.io/Malody/';

export default function App() {
  const web = useRef(null);
  const [playing, setPlaying] = useState(false);
  const { width, height } = useWindowDimensions();

  useEffect(() => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
  }, []);

  const onMessage = useCallback((e) => {
    try {
      const m = JSON.parse(e.nativeEvent.data);
      if (m.type === 'play') setPlaying(!!m.active);
    } catch {
      // 関係ないメッセージ
    }
  }, []);

  // 新しく触れた指だけを Web 版へ渡す（1 つのイベントに複数の指が入っていることがある）
  const onTouchStart = useCallback(
    (e) => {
      const list = e.nativeEvent.changedTouches || [e.nativeEvent];
      let js = '';
      for (const t of list) {
        const x = t.pageX / width;
        const y = t.pageY / height;
        const ts = typeof t.timestamp === 'number' ? t.timestamp : e.nativeEvent.timestamp;
        js += `window.__nativeHit&&window.__nativeHit(${x.toFixed(4)},${y.toFixed(4)},${Number(ts) || 'undefined'});`;
      }
      web.current?.injectJavaScript(js + 'true;');
    },
    [width, height],
  );

  return (
    <View style={styles.root}>
      <StatusBar hidden />
      <WebView
        ref={web}
        source={{ uri: URL }}
        style={styles.web}
        onMessage={onMessage}
        onLoadStart={() => setPlaying(false)}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        bounces={false}
        scrollEnabled={false}
        overScrollMode="never"
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        allowsBackForwardNavigationGestures={false}
        setSupportMultipleWindows={false}
      />
      {playing && <View style={StyleSheet.absoluteFill} onTouchStart={onTouchStart} />}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  web: { flex: 1, backgroundColor: '#000' },
});
