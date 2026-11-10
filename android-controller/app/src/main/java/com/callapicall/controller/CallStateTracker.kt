package com.callapicall.controller

// Superseduto da CallRegistry + CallControllerInCallService.
//
// Da quando l'app e' il dialer predefinito, lo stato delle chiamate arriva
// dall'InCallService di sistema (con numero e direzione), quindi il vecchio
// CallStateTracker basato su TelephonyCallback non serve piu'.
//
// Questo file e' lasciato vuoto di proposito (il tooling non permette di
// cancellarlo): puo' essere rimosso a mano.
