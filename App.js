import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Alert,
  BackHandler
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as Network from 'expo-network';
import * as ScreenOrientation from 'expo-screen-orientation';

export default function App() {
  const [myIP, setMyIP] = useState('');
  const [manualIP, setManualIP] = useState('');
  const [servers, setServers] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [streamUrl, setStreamUrl] = useState(null);
  const [scanProgress, setScanProgress] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [loading, setLoading] = useState(true);

  const webViewRef = useRef(null);

  useEffect(() => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    Network.getIpAddressAsync().then(ip => setMyIP(ip || '0.0.0.0'));

    const backAction = () => {
      if (streamUrl) { disconnect(); return true; }
      return false;
    };
    const backHandler = BackHandler.addEventListener("hardwareBackPress", backAction);
    return () => backHandler.remove();
  }, [streamUrl]);

  const connectToServer = (url) => {
    let cleanUrl = url.trim();
    if (!cleanUrl.includes(':')) cleanUrl = `${cleanUrl}:5000`;
    if (!cleanUrl.startsWith('http')) cleanUrl = `http://${cleanUrl}`;
    setLoading(true);
    setStreamUrl(cleanUrl);
  };

  const toggleFullscreen = async () => {
    if (!isFullscreen) {
      await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
      setIsFullscreen(true);
    } else {
      await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
      setIsFullscreen(false);
    }
  };

  const disconnect = async () => {
    setStreamUrl(null);
    setIsFullscreen(false);
    await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
  };

  // Reliable timeout using Promise.race
  const fetchWithTimeout = (url, ms = 1200) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), ms);
    return fetch(url, { signal: controller.signal })
      .finally(() => clearTimeout(id));
  };

  const scan = async () => {
    if (!myIP || myIP === '0.0.0.0') {
      return Alert.alert("No WiFi", "Connect to WiFi first");
    }

    setScanning(true);
    setServers([]);
    setScanProgress(0);

    const prefix = myIP.substring(0, myIP.lastIndexOf('.'));
    const foundServers = [];
    const BATCH_SIZE = 20;

    for (let i = 1; i < 255; i += BATCH_SIZE) {
      setScanProgress(Math.floor((i / 255) * 100));

      const batch = [];
      for (let j = 0; j < BATCH_SIZE; j++) {
        const id = i + j;
        if (id > 254) break;

        const targetIp = `${prefix}.${id}`;
        const promise = fetchWithTimeout(`http://${targetIp}:5000`, 1200)
          .then(() => {
            const serverUrl = `${targetIp}:5000`;
            if (!foundServers.includes(serverUrl)) {
              foundServers.push(serverUrl);
              setServers(prev => [...new Set([...prev, serverUrl])]);
            }
          })
          .catch(() => {});

        batch.push(promise);
      }

      await Promise.all(batch);
    }

    setScanProgress(100);
    setScanning(false);

    if (foundServers.length === 0) {
      Alert.alert(
        "No Servers Found",
        "Tips:\n• Check Windows Firewall\n• Allow Python on port 5000\n• Or use manual IP entry"
      );
    }
  };

  // --- STREAM VIEW ---
  if (streamUrl) {
    return (
      <View style={styles.streamContainer}>
        <WebView
          ref={webViewRef}
          source={{ uri: streamUrl }}
          style={styles.webview}
          originWhitelist={['*']}
          mixedContentMode="always"
          javaScriptEnabled={true}
          domStorageEnabled={true}
          allowsFullscreenVideo={true}
          mediaPlaybackRequiresUserAction={false}
          startInLoadingState={false}
          onLoadStart={() => setLoading(true)}
          onLoadEnd={() => setLoading(false)}
          onError={() => {
            Alert.alert(
              "Connection Failed",
              `Cannot connect to:\n${streamUrl}\n\nMake sure:\n• Server is running\n• Same WiFi network\n• Port 5000 not blocked`,
              [{ text: "OK", onPress: disconnect }]
            );
          }}
        />

        {loading && (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator size="large" color="#3b82f6" />
            <Text style={styles.loadingText}>Connecting...</Text>
          </View>
        )}

        <View style={styles.overlay}>
          <TouchableOpacity style={styles.exitBtn} onPress={disconnect}>
            <Text style={styles.btnIcon}>✕</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.fullscreenBtn} onPress={toggleFullscreen}>
            <Text style={styles.btnIcon}>{isFullscreen ? '⇲' : '⛶'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // --- HOME VIEW ---
  return (
    <View style={styles.container}>
      <Text style={styles.title}>🎥 Connect</Text>
      <Text style={styles.subtitle}>Your IP: {myIP}</Text>

      {/* Manual Entry */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>MANUAL CONNECTION</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. 192.168.1.208 or 192.168.1.208:5000"
          placeholderTextColor="#555"
          value={manualIP}
          onChangeText={setManualIP}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="default"
        />
        <TouchableOpacity
          style={[styles.primaryBtn, !manualIP && styles.btnDisabled]}
          onPress={() => manualIP && connectToServer(manualIP)}
          disabled={!manualIP}
        >
          <Text style={styles.btnText}>▶ CONNECT</Text>
        </TouchableOpacity>
      </View>

      {/* Auto Scan */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>AUTO DISCOVERY</Text>
        <TouchableOpacity
          style={[styles.secondaryBtn, scanning && styles.btnDisabled]}
          onPress={scan}
          disabled={scanning}
        >
          {scanning ? (
            <View style={styles.row}>
              <ActivityIndicator color="#fff" size="small" />
              <Text style={styles.btnText}>  SCANNING {scanProgress}%</Text>
            </View>
          ) : (
            <Text style={styles.btnText}>🔍 SCAN NETWORK</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Found Servers */}
      {servers.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>FOUND SERVERS ({servers.length})</Text>
          <ScrollView style={styles.list}>
            {servers.map((s, i) => (
              <TouchableOpacity
                key={i}
                style={styles.serverItem}
                onPress={() => connectToServer(s)}
              >
                <Text style={styles.serverText}>📺  {s}</Text>
                <Text style={styles.arrow}>→</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Empty State */}
      {servers.length === 0 && !scanning && (
        <View style={styles.tipBox}>
          <Text style={styles.tipTitle}>💡 Tips</Text>
          <Text style={styles.tipText}>
            • Enter IP manually if scan fails{'\n'}
            • Allow Python through Windows Firewall{'\n'}
            • Both devices must be on same WiFi{'\n'}
            • Default port is 5000
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    padding: 20,
    paddingTop: 50
  },
  title: {
    color: '#3b82f6',
    fontSize: 32,
    fontWeight: 'bold',
    marginBottom: 4
  },
  subtitle: {
    color: '#666',
    fontSize: 13,
    marginBottom: 28
  },
  section: {
    marginBottom: 22
  },
  sectionTitle: {
    color: '#555',
    fontSize: 11,
    fontWeight: 'bold',
    letterSpacing: 1.5,
    marginBottom: 10
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center'
  },
  input: {
    backgroundColor: '#111',
    color: '#fff',
    padding: 15,
    borderRadius: 10,
    marginBottom: 10,
    fontSize: 14,
    borderWidth: 1,
    borderColor: '#222'
  },
  primaryBtn: {
    backgroundColor: '#3b82f6',
    padding: 16,
    borderRadius: 10,
    alignItems: 'center'
  },
  secondaryBtn: {
    backgroundColor: '#1f2937',
    padding: 16,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#374151'
  },
  btnDisabled: {
    opacity: 0.35
  },
  btnText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 14
  },
  list: {
    maxHeight: 220
  },
  serverItem: {
    backgroundColor: '#111',
    padding: 16,
    borderRadius: 10,
    marginBottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#222'
  },
  serverText: {
    color: '#fff',
    fontSize: 14
  },
  arrow: {
    color: '#3b82f6',
    fontSize: 20,
    fontWeight: 'bold'
  },
  tipBox: {
    flex: 1,
    backgroundColor: '#0a0a0a',
    padding: 20,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1a1a1a'
  },
  tipTitle: {
    color: '#3b82f6',
    fontWeight: 'bold',
    marginBottom: 10,
    fontSize: 14
  },
  tipText: {
    color: '#555',
    fontSize: 13,
    lineHeight: 24
  },
  streamContainer: {
    flex: 1,
    backgroundColor: '#000'
  },
  webview: {
    flex: 1
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0, bottom: 0, left: 0, right: 0,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center'
  },
  loadingText: {
    color: '#3b82f6',
    marginTop: 12,
    fontSize: 14
  },
  overlay: {
    position: 'absolute',
    top: 40,
    left: 20,
    right: 20,
    flexDirection: 'row',
    justifyContent: 'space-between'
  },
  exitBtn: {
    backgroundColor: '#ef4444',
    width: 46,
    height: 46,
    borderRadius: 23,
    justifyContent: 'center',
    alignItems: 'center'
  },
  fullscreenBtn: {
    backgroundColor: '#3b82f6',
    width: 46,
    height: 46,
    borderRadius: 23,
    justifyContent: 'center',
    alignItems: 'center'
  },
  btnIcon: {
    color: '#fff',
    fontSize: 20,
    fontWeight: 'bold'
  }
});
