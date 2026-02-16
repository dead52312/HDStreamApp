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
  BackHandler,
  StatusBar,
  PermissionsAndroid,
  Platform,
  ToastAndroid
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as Network from 'expo-network';
import * as ScreenOrientation from 'expo-screen-orientation';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { CameraView, useCameraPermissions } from 'expo-camera';

export default function App() {
  const [myIP, setMyIP] = useState('');
  const [manualIP, setManualIP] = useState('');
  const [servers, setServers] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [streamUrl, setStreamUrl] = useState(null);
  const [scanProgress, setScanProgress] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showQRScanner, setShowQRScanner] = useState(false);
  const [qrScanned, setQrScanned] = useState(false);

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const webViewRef = useRef(null);

  useEffect(() => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    Network.getIpAddressAsync().then(ip => setMyIP(ip || '0.0.0.0'));

    const backAction = () => {
      if (showQRScanner) { closeQRScanner(); return true; }
      if (streamUrl) { disconnect(); return true; }
      return false;
    };
    const backHandler = BackHandler.addEventListener("hardwareBackPress", backAction);
    return () => backHandler.remove();
  }, [streamUrl, showQRScanner]);

  const connectToServer = (url) => {
    let cleanUrl = url.trim();
    if (!cleanUrl.includes(':')) cleanUrl = `${cleanUrl}:5000`;
    if (!cleanUrl.startsWith('http')) cleanUrl = `http://${cleanUrl}`;
    setLoading(true);
    setStreamUrl(cleanUrl);
  };

  const openQRScanner = async () => {
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) {
        Alert.alert(
          "Camera Permission Required",
          "Please allow camera access to scan QR codes.",
          [{ text: "OK" }]
        );
        return;
      }
    }
    setQrScanned(false);
    setShowQRScanner(true);
  };

  const closeQRScanner = () => {
    setShowQRScanner(false);
    setQrScanned(false);
  };

  const handleQRScanned = ({ data }) => {
    if (qrScanned) return;
    setQrScanned(true);

    // Accept http/https links or plain IPs
    if (data && (data.startsWith('http') || data.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/))) {
      setShowQRScanner(false);
      connectToServer(data);
    } else {
      Alert.alert(
        "Invalid QR Code",
        "This QR code doesn't contain a valid server address.\n\nExpected: http://192.168.x.x:5000",
        [{ text: "Scan Again", onPress: () => setQrScanned(false) }, { text: "Cancel", onPress: closeQRScanner }]
      );
    }
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
  // ─── Download handler ─────────────────────────────────────────────────────
  // Works for ALL file types on Android (pdf, zip, mp4, jpg, etc.)
  // Saves to:  <internal cache>/Connect/<filename>  then shares / confirms
  const handleDownload = async (downloadUrl) => {
    try {
      // --- 1. Request WRITE_EXTERNAL_STORAGE on Android < 10 ----------------
      if (Platform.OS === 'android' && Platform.Version < 29) {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
          {
            title: 'Storage Permission',
            message: 'Connect needs storage access to save downloaded files.',
            buttonPositive: 'Allow',
          }
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          Alert.alert('Permission Denied', 'Storage permission is required to download files.');
          return;
        }
      }

      // --- 2. Build destination path inside app's cache --------------------
      //   FileSystem.cacheDirectory  →  e.g. file:///data/user/0/<pkg>/cache/
      //   We create a "Connect" sub-folder so files are grouped together.
      const connectDir = FileSystem.cacheDirectory + 'Connect/';
      const dirInfo = await FileSystem.getInfoAsync(connectDir);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(connectDir, { intermediates: true });
      }

      // Derive a clean filename from the URL (strip query-string if any)
      const rawName = downloadUrl.split('/').pop().split('?')[0] || 'download';
      const filename = decodeURIComponent(rawName);
      const destUri  = connectDir + filename;

      // --- 3. Show a toast so the user knows the download started ----------
      if (Platform.OS === 'android') {
        ToastAndroid.show(`Downloading ${filename}…`, ToastAndroid.SHORT);
      }

      // --- 4. Download the file --------------------------------------------
      const downloadResumable = FileSystem.createDownloadResumable(
        downloadUrl,
        destUri,
        {},
        // Progress callback – optional, kept lightweight
        ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
          if (totalBytesExpectedToWrite > 0) {
            const pct = Math.round((totalBytesWritten / totalBytesExpectedToWrite) * 100);
            // Could drive a progress bar here; for now just log
            console.log(`Download progress: ${pct}%`);
          }
        }
      );

      const result = await downloadResumable.downloadAsync();
      if (!result || !result.uri) {
        throw new Error('Download returned no URI');
      }

      // --- 5. Offer to open / share the file (works for ALL mime types) ----
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        // On Android this opens the standard "Open with" / share sheet
        await Sharing.shareAsync(result.uri, {
          dialogTitle: `File saved – ${filename}`,
          // Expo Sharing auto-detects mime type from extension
        });
      } else {
        Alert.alert(
          '✅ Downloaded',
          `"${filename}" saved to Connect folder.\n\nPath: Connect/${filename}`
        );
      }

    } catch (err) {
      console.error('Download error:', err);
      Alert.alert(
        'Download Failed',
        `Could not download the file.\n\n${err.message || 'Unknown error'}`
      );
    }
  };
  // ─── Injected JS: intercept all download-intent clicks on Android ─────────
  // WebView on Android does NOT fire onFileDownload. Instead we hook every
  // anchor click that carries a "download" attribute or points to a file, and
  // post the URL back via window.ReactNativeWebView.postMessage so the RN
  // side can call handleDownload().
  const INJECTED_JS = `
    (function() {
      function interceptDownload(e) {
        var el = e.target;
        // Walk up the DOM in case the click landed on a child element
        while (el && el.tagName !== 'A') el = el.parentElement;
        if (!el) return;

        var href = el.href || '';
        var hasDownload = el.hasAttribute('download');
        var looksLikeFile = /\\.(pdf|zip|rar|7z|tar|gz|mp4|mp3|avi|mkv|mov|docx?|xlsx?|pptx?|apk|exe|dmg|iso|csv|json|txt|png|jpe?g|gif|webp|svg)(\\?.*)?$/i.test(href);

        if (hasDownload || looksLikeFile) {
          e.preventDefault();
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'DOWNLOAD', url: href }));
        }
      }
      document.addEventListener('click', interceptDownload, true);
    })();
    true; // required return value
  `;

  // --- QR SCANNER VIEW ---
  if (showQRScanner) {
    return (
      <View style={styles.qrContainer}>
        <StatusBar barStyle="light-content" backgroundColor="#000" />
        <CameraView
          style={StyleSheet.absoluteFillObject}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={qrScanned ? undefined : handleQRScanned}
        />

        {/* Dark overlay with hole effect */}
        <View style={styles.qrOverlay}>
          <View style={styles.qrTopOverlay} />
          <View style={styles.qrMiddleRow}>
            <View style={styles.qrSideOverlay} />
            <View style={styles.qrFrame}>
              {/* Corner markers */}
              <View style={[styles.corner, styles.cornerTL]} />
              <View style={[styles.corner, styles.cornerTR]} />
              <View style={[styles.corner, styles.cornerBL]} />
              <View style={[styles.corner, styles.cornerBR]} />
            </View>
            <View style={styles.qrSideOverlay} />
          </View>
          <View style={styles.qrBottomOverlay} />
        </View>

        {/* Header */}
        <View style={styles.qrHeader}>
          <TouchableOpacity style={styles.qrCloseBtn} onPress={closeQRScanner}>
            <Text style={styles.qrCloseBtnText}>✕</Text>
          </TouchableOpacity>
          <Text style={styles.qrTitle}>Scan QR Code</Text>
          <View style={{ width: 46 }} />
        </View>

        {/* Bottom hint */}
        <View style={styles.qrHint}>
          <Text style={styles.qrHintText}>Point camera at server QR code</Text>
          <Text style={styles.qrHintSub}>The QR code should contain the server's HTTP link</Text>
        </View>
      </View>
    );
  }

  // --- STREAM VIEW ---
  if (streamUrl) {
    return (
      <View style={styles.streamContainer}>
        <WebView
          ref={webViewRef}
          source={{ uri: streamUrl }}
          style={styles.webview}
          originWhitelist={['*']}
          // iOS: fires when the browser would normally prompt a download
          onFileDownload={({ nativeEvent: { downloadUrl } }) => handleDownload(downloadUrl)}
          // Android: receives messages posted by INJECTED_JS
          onMessage={(event) => {
            try {
              const msg = JSON.parse(event.nativeEvent.data);
              if (msg.type === 'DOWNLOAD' && msg.url) {
                handleDownload(msg.url);
              }
            } catch (_) {}
          }}
          injectedJavaScript={INJECTED_JS}
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

      {/* QR Scanner */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>QR CODE</Text>
        <TouchableOpacity style={styles.qrBtn} onPress={openQRScanner}>
          <Text style={styles.qrBtnIcon}>▦</Text>
          <Text style={styles.qrBtnText}>SCAN QR CODE</Text>
        </TouchableOpacity>
      </View>

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
            • Scan server QR code for instant connect{'\n'}
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
  qrBtn: {
    backgroundColor: '#10b981',
    padding: 16,
    borderRadius: 10,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10
  },
  qrBtnIcon: {
    color: '#fff',
    fontSize: 22,
    fontWeight: 'bold'
  },
  qrBtnText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 14,
    letterSpacing: 1
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
  },

  // QR Scanner styles
  qrContainer: {
    flex: 1,
    backgroundColor: '#000'
  },
  qrOverlay: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'column'
  },
  qrTopOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)'
  },
  qrMiddleRow: {
    flexDirection: 'row',
    height: 260
  },
  qrSideOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)'
  },
  qrFrame: {
    width: 260,
    height: 260,
    position: 'relative'
  },
  qrBottomOverlay: {
    flex: 1.5,
    backgroundColor: 'rgba(0,0,0,0.65)'
  },
  corner: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderColor: '#10b981',
    borderWidth: 3
  },
  cornerTL: {
    top: 0, left: 0,
    borderBottomWidth: 0, borderRightWidth: 0,
    borderTopLeftRadius: 4
  },
  cornerTR: {
    top: 0, right: 0,
    borderBottomWidth: 0, borderLeftWidth: 0,
    borderTopRightRadius: 4
  },
  cornerBL: {
    bottom: 0, left: 0,
    borderTopWidth: 0, borderRightWidth: 0,
    borderBottomLeftRadius: 4
  },
  cornerBR: {
    bottom: 0, right: 0,
    borderTopWidth: 0, borderLeftWidth: 0,
    borderBottomRightRadius: 4
  },
  qrHeader: {
    position: 'absolute',
    top: 50,
    left: 20,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  qrCloseBtn: {
    backgroundColor: 'rgba(255,255,255,0.15)',
    width: 46,
    height: 46,
    borderRadius: 23,
    justifyContent: 'center',
    alignItems: 'center'
  },
  qrCloseBtnText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold'
  },
  qrTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold'
  },
  qrHint: {
    position: 'absolute',
    bottom: 80,
    left: 20,
    right: 20,
    alignItems: 'center'
  },
  qrHintText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: 'bold',
    marginBottom: 6
  },
  qrHintSub: {
    color: '#aaa',
    fontSize: 12,
    textAlign: 'center'
  }
});
