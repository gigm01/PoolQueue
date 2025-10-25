import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState, useRef } from 'react';
import { StyleSheet, Text, View, Button, Modal, Alert, AppState } from 'react-native';
import * as Location from 'expo-location';
import initFirebase from './firebaseConfig';
import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'firebase/functions';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';

// Initialize Firebase (safe if config missing)
const app = initFirebase();

export default function App() {
  const [consentVisible, setConsentVisible] = useState(true);
  const [hasPermission, setHasPermission] = useState(false);
  const [location, setLocation] = useState(null);
  const [checkingIn, setCheckingIn] = useState(false);
  const [checkedInVenue, setCheckedInVenue] = useState(null);
  const [user, setUser] = useState(null);
  const functionsRef = useRef(null);
  const appState = useRef(AppState.currentState);

  useEffect(() => {
    const auth = getAuth();
    // Sign in anonymously for dev flows so callables have an auth context.
    signInAnonymously(auth).catch(() => {});
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));

    // Initialize Functions client
    if (app) {
      const funcs = getFunctions(app);
      // If you're running emulators locally, uncomment and adjust host/port below
      // connectFunctionsEmulator(funcs, 'localhost', 5001);
      functionsRef.current = funcs;
    }

    return () => unsub();
  }, []);

  // Heartbeat: when app comes to foreground, trigger a refreshPresence if checked in
  useEffect(() => {
    function handleAppStateChange(next) {
      if (appState.current.match(/inactive|background/) && next === 'active') {
        if (checkedInVenue) {
          refreshPresence();
        }
      }
      appState.current = next;
    }
    const sub = AppState.addEventListener('change', handleAppStateChange);

    // Periodic heartbeat while app is active and user is checked in
    let intervalId = null;
    function startHeartbeat() {
      // 5 minutes
      const ms = 5 * 60 * 1000;
      if (intervalId) return;
      intervalId = setInterval(() => {
        if (appState.current === 'active' && checkedInVenue) {
          refreshPresence();
        }
      }, ms);
    }
    function stopHeartbeat() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }

    // Start/stop based on current checked-in state
    if (checkedInVenue) startHeartbeat();

    return () => {
      sub.remove();
      stopHeartbeat();
    };
  }, [checkedInVenue]);

  async function requestPermission() {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission denied', 'Location permission is required to check in to venues.');
        setHasPermission(false);
        return false;
      }
      setHasPermission(true);
      setConsentVisible(false);
      return true;
    } catch (e) {
      console.warn('Permission request failed', e);
      return false;
    }
  }

  async function getCurrentLocation() {
    if (!hasPermission) {
      const ok = await requestPermission();
      if (!ok) return null;
    }
    try {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const coords = pos.coords ? { latitude: pos.coords.latitude, longitude: pos.coords.longitude } : null;
      setLocation(coords);
      return coords;
    } catch (err) {
      console.warn('Failed to get location', err);
      Alert.alert('Error', 'Unable to get location.');
      return null;
    }
  }

  async function checkIn() {
    setCheckingIn(true);
    try {
      const coords = await getCurrentLocation();
      if (!coords) return;

      const funcs = functionsRef.current;
      if (!funcs) {
        Alert.alert('Not configured', 'Firebase functions client not available.');
        return;
      }

      const getNearby = httpsCallable(funcs, 'getNearbyVenues');
      const nearbyRes = await getNearby({ lat: coords.latitude, lng: coords.longitude, radiusMeters: 500 });
      const venues = nearbyRes.data || [];
      if (!venues.length) {
        Alert.alert('No nearby venues', 'No venues found within 500m.');
        return;
      }

      const venue = venues[0];
      const checkInFn = httpsCallable(funcs, 'checkIn');
      await checkInFn({ venueId: venue.id, lat: coords.latitude, lng: coords.longitude });
      setCheckedInVenue(venue.id);
      Alert.alert('Checked in', `Checked in to ${venue.name || venue.id}`);
    } catch (err) {
      console.warn('checkIn error', err);
      Alert.alert('Check-in failed', String(err?.message || err));
    } finally {
      setCheckingIn(false);
    }
  }

  async function checkOut() {
    try {
      const funcs = functionsRef.current;
      if (!funcs) {
        Alert.alert('Not configured', 'Firebase functions client not available.');
        return;
      }
      const checkOutFn = httpsCallable(funcs, 'checkOut');
      await checkOutFn({ venueId: checkedInVenue });
      setCheckedInVenue(null);
      Alert.alert('Checked out');
    } catch (err) {
      console.warn('checkOut error', err);
      Alert.alert('Check-out failed', String(err?.message || err));
    }
  }

  async function refreshPresence() {
    try {
      const funcs = functionsRef.current;
      if (!funcs) return;
      const fn = httpsCallable(funcs, 'refreshPresence');
      await fn({ venueId: checkedInVenue });
    } catch (err) {
      console.warn('refreshPresence failed', err);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>PoolQueue</Text>
      <Text>Signed in: {user ? user.uid : 'not signed'}</Text>
      <Text>Location permission: {hasPermission ? 'granted' : 'not granted'}</Text>
      <Text>Current coords: {location ? `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}` : 'unknown'}</Text>
      <View style={{ height: 12 }} />
      <Button title={checkedInVenue ? 'Checked in — Check out' : 'Check in (nearest)'} onPress={checkedInVenue ? checkOut : checkIn} disabled={checkingIn} />
      <View style={{ height: 8 }} />
      <Button title="Refresh presence now" onPress={refreshPresence} disabled={!checkedInVenue} />
      <StatusBar style="auto" />

      <Modal visible={consentVisible} transparent animationType="slide">
        <View style={styles.modalOuter}>
          <View style={styles.modalInner}>
            <Text style={styles.modalTitle}>Location permission</Text>
            <Text style={{ marginBottom: 12 }}>
              PoolQueue needs your location to check you into nearby venues. We will not publish your exact location — only the venue you check into and aggregated counts. Do you agree?
            </Text>
            <Button title="I agree — Allow" onPress={requestPermission} />
            <View style={{ height: 8 }} />
            <Button title="No thanks" onPress={() => setConsentVisible(false)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
    marginBottom: 8,
  },
  modalOuter: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalInner: {
    width: '88%',
    backgroundColor: 'white',
    padding: 20,
    borderRadius: 8,
    elevation: 4,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
});
