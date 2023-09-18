import React, { useState, useEffect } from 'react';
import { Button, StyleSheet, TextInput, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage'
import POSTerminal from '@paytecag/ecritf';

var trm = null;

const App = () => {
  const [ pairingCode, setPairingCode ] = useState('');
  const [ pairingInfo, setPairingInfo ] = useState();
  const [ trmStatus, setTrmStatus]  = useState(0);
  const [ amtAuth, setAmtAuth ] = useState('');
  const [ transactionRunning, setTransactionRunning ] = useState(false);

  async function savePairingInfo(info) {
    if (info !== null) {
      try {
        console.log("Saving PairingInfo...");
        await AsyncStorage.setItem("PairingInfo", JSON.stringify(info));
      } catch (e) {
        console.error(`Failed to save PairingInfo - ${e.message}`);
      }
    } else {
      try {
        console.log("Removing PairingInfo...");
        await AsyncStorage.removeItem("PairingInfo");
      } catch (e) {
        console.error(`Failed to remove PairingInfo - ${e.message}`);
      }
    }

    setPairingInfo(info)
  }
  
  useEffect(() => {
    console.log("Loading PairingInfo...");

    AsyncStorage.getItem("PairingInfo").then((value) => {  
      const info = JSON.parse(value);

      console.log("PairingInfo loaded: " + info);
      setPairingInfo(info);
    });
  }, []);

  useEffect(() => {
    if (pairingInfo !== undefined) {
      instantiateTerminal();
    }
  }, [pairingInfo]);

  function instantiateTerminal() {
    trm = POSTerminal(pairingInfo, {
      OnConnected: () => console.log("Connected!"),
      OnDisconnected: () => console.log("Disconnected!"),
      OnPairingSucceeded: () => { savePairingInfo(trm.getPairingInfo()); },
      OnStatusChanged: () => setTrmStatus(trm.getStatus()),
      OnReceipt: (receiptType, receiptText) => console.log(receiptText),
      OnTransactionConfirmationSucceeded: onTransactionOK,
      OnTransactionDeclined: onTransactionFailed,
      OnTransactionAborted: onTransactionFailed
    });
  }

  function onTransactionOK(trxResponse) {
    setTransactionRunning(false);
    setAmtAuth('');
    alert("Transaction OK!");
  }

  function onTransactionFailed(trxResponse) {
    setTransactionRunning(false);
    setAmtAuth('');
    alert("Transaction Failed: " + trxResponse.AttendantText);
  }

  function pairTerminal() {
    if (trm === null) {
      instantiateTerminal();
    }

    trm.pair(pairingCode, "React-native POS");
    setPairingCode('');
  }

  function unpairTerminal() {
    trm.unpair();
    savePairingInfo(null);
  }

  const isShiftOpen = () => (trm && trm.StatusFlags.SHIFT_OPEN & trmStatus);
  const isBusy = () => (trm && (trm.StatusFlags.BUSY | trm.StatusFlags.LOCKED) & trmStatus);

  function startTransaction() {
    trm.startTransaction({
      TrxCurrC: 756,
      TrxFunction: trm.TransactionFunctions.PURCHASE,
      AmtAuth: Math.round(Number(amtAuth) * 100)
     });

     setTransactionRunning(true);
  }

  function abortTransaction() {
    trm.abortTransaction();
    setTransactionRunning(false);
    setAmtAuth('');
  }
  
  return pairingInfo != null ?
    ( isShiftOpen() ? (
      <View style={styles.container}>
        <TextInput
          placeholder="Enter Amount"
          value={amtAuth}
          onChangeText={(text) => setAmtAuth(text)}
          />
        { !transactionRunning ? (
        <Button
          title="Pay"
          {...(isBusy() || (amtAuth === '') ? { disabled: true } : {}) }
          onPress={startTransaction} />
        ) : (
        <Button
          title="Abort"
          onPress={abortTransaction} />
        )}
        <Button
          {...(isBusy() ? { disabled: true } : {}) }
          title="deactivate"
          onPress={() => trm.deactivate() } />
        <Button title="Unpair" onPress={unpairTerminal}></Button>
      </View>
    ) : (
    <View style={styles.container}>
      <Button
        title="Activate"
        onPress={() => trm.activate() } />
      <Button title="Unpair" onPress={unpairTerminal}></Button>
    </View>
    )
  ) : (
    <View style={styles.container}>
      <TextInput
        placeholder="Enter Pairing Code"
        value={pairingCode}
        onChangeText={(text) => setPairingCode(text)}
      />
      <Button title="Pair Terminal" onPress={pairTerminal} />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    maxWidth: 300,
    flex: 1,
    justifyContent: 'center',
    alignContent: 'center',
    alignItems: 'stretch',
    padding: 20,
    gap: 20
  },
});

export default App;