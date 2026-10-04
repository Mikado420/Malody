/**
 * Malody Web Editor を Expo Go の中で動かすためのアプリ（Expo Snack 用の 1 ファイル）
 *
 * iPhone の Safari（WebKit）は、両手交互で速く叩いて「指が 1 本も触れていない瞬間」に
 * 次の指が触れると、そのタッチをページに届けないことがある。
 * そこでテストプレイ中だけ、Web 版の上に透明な層を重ね、アプリ（React Native）の仕組みで指を受け取って
 * Web 版の window.__nativeHit(x, y, 時刻, 方式, 通し番号) に渡す。エディタを使うときは層を外す。
 *
 * 受け取り方は Web 版の「情報 → アプリでのタッチの受け取り方」で切り替える
 *   rn: React Native の onTouchStart
 *   gh: react-native-gesture-handler（Gesture.Manual の onTouchesDown）
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { WebView } from 'react-native-webview';
import { StatusBar } from 'expo-status-bar';
import * as ScreenOrientation from 'expo-screen-orientation';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';

const URL = 'https://mikado420.github.io/Malody/';

export default function App() {
  const web = useRef(null);
  const seq = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState('rn');
  const { width, height } = useWindowDimensions();

  useEffect(() => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
  }, []);

  const onMessage = useCallback((e) => {
    try {
      const m = JSON.parse(e.nativeEvent.data);
      if (m.type === 'play') {
        setPlaying(!!m.active);
        if (m.active) seq.current = 0;
      }
      if (m.type === 'mode' && (m.mode === 'rn' || m.mode === 'gh')) setMode(m.mode);
    } catch {
      // 関係ないメッセージ
    }
  }, []);

  /** 指（画面上の位置 px）を Web 版へ渡す */
  const send = useCallback(
    (points, tag) => {
      let js = '';
      for (const p of points) {
        seq.current += 1;
        const ts = Number(p.ts);
        js += `window.__nativeHit&&window.__nativeHit(${(p.x / width).toFixed(4)},${(p.y / height).toFixed(4)},${isFinite(ts) && ts > 0 ? ts : 'undefined'},"${tag}",${seq.current});`;
      }
      if (js) web.current?.injectJavaScript(js + 'true;');
    },
    [width, height],
  );

  // React Native の onTouchStart（新しく触れた指だけが changedTouches に入る）
  const onTouchStart = useCallback(
    (e) => {
      const ne = e.nativeEvent;
      const list = ne.changedTouches && ne.changedTouches.length ? ne.changedTouches : [ne];
      send(
        list.map((t) => ({ x: t.pageX, y: t.pageY, ts: t.timestamp ?? ne.timestamp })),
        'rn',
      );
    },
    [send],
  );

  // react-native-gesture-handler
  const gesture = useMemo(
    () =>
      Gesture.Manual()
        .runOnJS(true)
        .onTouchesDown((e) => {
          send(
            (e.changedTouches || []).map((t) => ({ x: t.absoluteX, y: t.absoluteY })),
            'gh',
          );
        }),
    [send],
  );

  return (
    <GestureHandlerRootView style={styles.root}>
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
      {playing && mode === 'rn' && <View style={StyleSheet.absoluteFill} onTouchStart={onTouchStart} />}
      {playing && mode === 'gh' && (
        <GestureDetector gesture={gesture}>
          <View style={StyleSheet.absoluteFill} collapsable={false} />
        </GestureDetector>
      )}
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  web: { flex: 1, backgroundColor: '#000' },
});
