#!/bin/bash
# Hermes Gateway wrapper per servizio Windows NSSM
# Monitora il servizio systemd e resta in foreground.
# Se il servizio muore, lo riavvia automaticamente.
# Se questo script viene killato (stop del servizio Windows), ferma anche il gateway.
set -e

cleanup() {
    echo "Stopping hermes-gateway and hermes-phone (systemd)..."
    systemctl --user stop hermes-gateway 2>/dev/null || true
    systemctl --user stop hermes-phone 2>/dev/null || true
}
trap cleanup EXIT

systemctl --user reset-failed hermes-gateway 2>/dev/null || true
systemctl --user reset-failed hermes-phone 2>/dev/null || true
systemctl --user start hermes-gateway
systemctl --user start hermes-phone

# Monitora il servizio: se si ferma, lo riavvia dopo un pausa
while true; do
    # systemctl wait blocca finche' il servizio si ferma
    if ! systemctl --user wait hermes-gateway 2>/dev/null; then
        echo "Gateway stopped or wait interrupted. Checking status..."
        sleep 2
        if systemctl --user is-failed hermes-gateway &>/dev/null; then
            echo "Gateway failed, resetting and restarting..."
            systemctl --user reset-failed hermes-gateway 2>/dev/null || true
            sleep 5
            systemctl --user start hermes-gateway
        elif ! systemctl --user is-active hermes-gateway &>/dev/null; then
            echo "Gateway not active, restarting..."
            sleep 5
            systemctl --user start hermes-gateway
        fi
    fi
done
