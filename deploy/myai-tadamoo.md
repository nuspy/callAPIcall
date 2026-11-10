# myai.tadamoo.com — come e' pubblicata la web app

La web app dell'avatar e' raggiungibile da internet su **https://myai.tadamoo.com**,
senza toccare il router di casa: il server pubblico tadamoo.com e' nel TailNet
e raggiunge il PC (<nome-del-pc>, <indirizzo-tailscale-del-pc>) da li'.

## Catena
```
browser  --https-->  Nginx Proxy Manager (tadamoo.com, hostNetwork :443)
                       |  cert Let's Encrypt (rinnovo automatico)
                       +-- /        -> <indirizzo-tailscale-del-pc>:8772/myAi/   (web app, via TailNet)
                       +-- /token   -> <indirizzo-tailscale-del-pc>:8772/token   (token del gateway)
                       +-- /ws      -> <indirizzo-tailscale-del-pc>:8771         (gateway WebSocket)
```

La pagina sta alla RADICE del dominio: la `location /` riscrive il prefisso
verso `/myAi/` sul bridge (`rewrite ^/(.*)$ /myAi/$1 break;`), quindi l'utente
apre `https://myai.tadamoo.com` e basta. Gli asset sono a percorso relativo, per
cui la stessa build funziona sia qui alla radice sia sotto /myAi/ dal bridge.

## Accesso
- **Nessuna password sulla pagina.** L'indirizzo e' pubblico.
- Il **token del gateway** l'app lo prende da sola da `/token`: non va incollato.

## Configurato in NPM (via API, host id 26)
- Proxy host `myai.tadamoo.com` -> `<indirizzo-tailscale-del-pc>:8772`, Websockets ON, Block Exploits ON
- Certificato Let's Encrypt
- `location /` con `rewrite ^/(.*)$ /myAi/$1 break;` (pagina alla radice)
- `location /ws` nell'advanced config con gli header di upgrade WebSocket

## Nota WebSocket
Il WebSocket funziona solo su HTTP/1.1: su HTTP/2 l'upgrade non esiste. I browser
lo gestiscono da soli; un test con `curl` va forzato con `--http1.1`.

## In alternativa, dentro il TailNet
`https://<nome-pc>.<tailnet>.ts.net/myAi/` — stesso servizio, raggiungibile solo
dai dispositivi nel TailNet.

## Sicurezza — DA DECIDERE
L'indirizzo e' pubblico e apre il microfono e l'avatar di casa. Il token protegge
il gateway, ma la pagina no. Se serve limitare l'accesso, le opzioni sono una
Access List (basic-auth) o un IP allow-list su NPM, oppure lasciarlo pubblico e
affidarsi al solo token. Scelta dell'utente.
