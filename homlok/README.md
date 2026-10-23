# Homlok Party 🎬

Magyar nyelvű, telefonos színész- és filmkitaláló baráti társaságoknak. Tartsd a telefont fekvő helyzetben a homlokodhoz: a többiek körülírják a kijelzőn látható színészt vagy filmet, te pedig megpróbálod kitalálni.

**[Játék indítása](https://jtdevzero.github.io/Mentalhealthhub/homlok/)**

## Játékmenet

1. Válassz paklit és 60, 90 vagy 120 másodperces kört.
2. Indítsd a játékot, fordítsd fekvő helyzetbe a telefont, és tartsd a homlokodhoz, a kijelzővel a többiek felé.
3. Ha kitaláltad, fordítsd a kijelzőt felfelé. Passzoláshoz fordítsd lefelé. Két billentés között állítsd vissza a telefont a homlokodhoz, függőleges kijelzősíkba.
4. A kör végén megnézhetitek a pontszámot és a megfejtéseket.

Négy pakli közül választhattok: **Világsztárok** (200 színész), **Magyar kedvencek** (120 színész), **Filmek** (250 filmcím, köztük 50 magyar film) és **Mindent bele!** (mind az 570 feladvány). A vegyes pakliban a kijelző a „Ki vagyok én?” vagy „Melyik film ez?” kérdéssel jelzi a feladvány típusát. A hangjelzések és a billentéses vezérlés opcionálisak.

iPhone-on az indításkor engedélyezni kell a mozgásérzékelők használatát, ha billentéssel szeretnétek játszani. Az érzékelők működése készülékenként és böngészőnként eltérhet; a **Megvan** és **Passz** gombokkal is végigjátszható minden kör.

Számítógépen: **←** passz, **→** megvan, **Szóköz** vagy **Escape** szünet.

## Ismétlés nélküli parti

A megjelent feladványok a következő körökben és másik pakliban sem ismétlődnek. A passzolt, illetve az idő lejártakor a kijelzőn maradt feladvány is látottnak számít. Csak a ténylegesen megjelenő kártyák fogynak a pakliból.

A pakliknál látjátok, mennyi új feladvány maradt. Ha egy pakli elfogyott, válasszatok másikat, vagy az **Új parti** gombbal keverjétek újra az összes feladványt. A játék magától nem hozza vissza a már látottakat.

Az előzmények az adott telefon böngészőjében tárolódnak, így újratöltés vagy későbbi megnyitás után is folytathatjátok a partit. Ha a böngésző nem engedi a helyi tárolást, az ismétlésvédelem az oldal bezárásáig működik.

## Futtatás helyben

Node.js 20 vagy újabb szükséges a helyi kiszolgálóhoz és a tesztekhez. Függőségeket nem kell telepíteni.

```sh
npm start
```

Nyisd meg: **http://localhost:4173**

A játékmotor, a paklik és a mentett parti tesztjei:

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
- A beállítások és a látott feladványok az adott böngésző `localStorage` tárhelyén maradnak. A játék nem használ külső képeket, betűkészleteket vagy adatbázist.

## Saját nevek

A paklik, a színésznevek és a filmcímek a `data.js` fájlban szerkeszthetők. A játék egyszerű HTML-, CSS- és JavaScript-fájlokból áll, külső függőségek nélkül.
