# Homlok Party 🎬

Magyar nyelvű, telefonos színészkitaláló baráti társaságoknak. Tartsd a telefont fekvő helyzetben a homlokodhoz: a többiek körülírják a kijelzőn látható színészt, te pedig megpróbálod kitalálni.

## Játékmenet

1. Válassz paklit és 60, 90 vagy 120 másodperces kört.
2. Indítsd a játékot, fordítsd fekvő helyzetbe a telefont, és tartsd a homlokodhoz, a kijelzővel a többiek felé.
3. Ha kitaláltad, fordítsd a kijelzőt felfelé. Passzoláshoz fordítsd lefelé. Két billentés között állítsd vissza a telefont a homlokodhoz, függőleges kijelzősíkba.
4. A kör végén megnézhetitek a pontszámot és a megfejtéseket.

Három pakli közül választhattok: **Világsztárok** (100 név), **Magyar kedvencek** (70 név) és **Mindent bele!** (mind a 170 név). A hangjelzések és a billentéses vezérlés opcionálisak.

iPhone-on az indításkor engedélyezni kell a mozgásérzékelők használatát, ha billentéssel szeretnétek játszani. Az érzékelők működése készülékenként és böngészőnként eltérhet; a **Megvan** és **Passz** gombokkal is végigjátszható minden kör.

Számítógépen: **←** passz, **→** megvan, **Szóköz** vagy **Escape** szünet.

## Futtatás helyben

Node.js 20 vagy újabb szükséges a helyi kiszolgálóhoz és a tesztekhez. Függőségeket nem kell telepíteni.

```sh
npm start
```

Nyisd meg: **http://localhost:4173**

A játékmotor tesztjei:

```sh
npm test
```

A HTML-fájl közvetlen, `file://` megnyitása nem megfelelő az ES-modulok miatt. Használd a helyi kiszolgálót vagy a GitHub Pages-változatot.

## Feltöltés GitHub Pagesre

1. Hozz létre egy GitHub-repót, és töltsd fel ebbe a mappába tartozó fájlokat a repó gyökerébe. Az `index.html` közvetlenül ott legyen.
2. A repóban nyisd meg: **Settings → Pages**.
3. A **Build and deployment** résznél válaszd: **Deploy from a branch**.
4. Állítsd be: **main**, **/ (root)**, majd **Save**.
5. Várd meg a közzétételt, és nyisd meg a Pages által megadott HTTPS-címet a telefonodon.

Az alkalmazás relatív útvonalakat használ, így a `https://felhasznalonev.github.io/repo-neve/` típusú címeken is működik. Saját szerverre is feltölthető; nincs szüksége háttérrendszerre vagy buildelésre.

## Telefonon és internet nélkül

- Ha megjelenik az elforgatási útmutató, kapcsold ki a telefon álló helyzetű tájolásának zárolását, majd fordítsd el a készüléket.
- iPhone-on a Safariban a **Megosztás → Főképernyőhöz adás** lehetőséggel külön ikonról indíthatod.
- Az első internetes megnyitás után a service worker elmenti a játék alapfájljait a későbbi offline használathoz. Ehhez HTTPS vagy `localhost` szükséges; az első betöltés és a gyorsítótárazás befejezése előtt még kell internet.
- A beállítások az adott böngésző `localStorage` tárhelyén maradnak. A játék nem használ külső képeket, betűkészleteket vagy adatbázist.

## Saját nevek

A paklik és a színésznevek a `data.js` fájlban szerkeszthetők. A játék egyszerű HTML-, CSS- és JavaScript-fájlokból áll, külső függőségek nélkül.
