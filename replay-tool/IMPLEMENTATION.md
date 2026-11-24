# Implementation — 2.8 Replay tool (text pentru documentul challenge-ului)

Pentru sub-challenge-ul 2.8 am construit **.lumen Replay**, o aplicație web care redă sincronizat toate fluxurile unei înregistrări ROS 2 MCAP. Așa se poate vedea, în orice moment, ce a intrat în componentă și ce a ieșit din ea. Aplicația rulează integral în browser (TypeScript, React, Vite) și nu are nevoie de ROS:
- fișierul e citit indexat (`@mcap/core`) direct dintr-un `Blob`, deci înregistrări de câțiva GB nu sunt încărcate în memorie;
- mesajele sunt decodate din schemele stocate în fișier (CDR, `ros2msg`/`ros2idl`), într-un Web Worker cu cache LRU și prefetch;
- nimic nu e hardcodat: topicurile, tipurile, frame-urile și câmpurile vizuale sunt descoperite din date.

Interfața e organizată după componentă, pe trei coloane (*Intrări | Ieșiri FOV 1 | Ieșiri FOV 2*), și are un timeline în care:
- fiecare mesaj e o bifă;
- golurile sunt evidențiate cu roșu;
- încălcările cerințelor sunt hașurate;
- eșecurile din rapoartele de test apar ca markere.

Fiecare panou afișează vârsta mesajului și starea lui (OK, întârziat, expirat, gol, invalid). Un panou de intrare poate afișa exact cadrul din care a fost produsă ieșirea curentă, iar latența live e tradusă în centimetri parcurși de utilizator.

Decizia tehnică principală a fost ca **toate calculele să stea într-o bibliotecă pură** (`src/core`), folosită identic de aplicație și de un CLI în Node (`npm run metrics`). Biblioteca acoperă:
- frecvențe, jitter, goluri și analiza ceasurilor;
- inferența cauzalității din `header.stamp`;
- latența, cadrele sărite și metricile de conținut;
- evaluarea cerințelor din `config/thresholds.yaml`.

Astfel, ce arată aplicația și ce raportează testele automate provin din același cod și din aceleași praguri, iar ecranul de validare încrucișată verifică acest lucru pe baza fișierelor `metrics.json`.

Instrumentul ajută direct analiza componentei:
- **2.1** — inventarul și graficele de regularitate se exportă în Markdown/CSV, gata de lipit în document;
- **2.2** — diagrama I/O nu e presupusă, ci dedusă: un topic e ieșire doar dacă copiază exact stamp-urile unei intrări și e publicat după ea;
- **2.3** — consistența nor 3D ↔ adâncime e calculată în timp, iar parametrii de calibrare lipsă sunt estimați (Nelder–Mead), cu încredere per parametru;
- **2.4** — profilurile *Derivat* și *Strict* sunt comparate cerință cu cerință;
- **2.5** — fiecare latență și gol e exprimat în distanța parcursă „orbește” la viteza estimată din IMU;
- **2.6** — bug-urile se creează dintr-un click, cu capturi, valori măsurate și pași de reproducere (deep-link și comandă CLI);
- **2.7** — notele și întrebările pentru dezvoltator sunt ancorate în timp.

Orice export conține SHA-256 al fișierului, versiunea aplicației și pragurile folosite, ca rezultatele să poată fi reproduse exact.

Pentru teste reproductibile am scris un generator de înregistrare sintetică deterministă, cu aceeași structură ca înregistrarea reală (două camere, IMU, CameraInfo, TF, adâncime și nor de puncte pe FOV), în care am **injectat defecte cunoscute**:
- vârf de latență;
- cadre sărite;
- gol de intrare;
- cadre înghețate;
- nor gol sau plin de NaN;
- stamp nemonoton;
- glitch de IMU;
- nor deplasat geometric.

Testele verifică faptul că aplicația le găsește pe toate: 36 de teste unitare și de integrare (Vitest) și 7 teste end-to-end (Playwright), inclusiv un audit automat de accesibilitate WCAG AA în ambele teme. Totul rulează cu o singură comandă: `npm run test:all`. Interfața respectă identitatea vizuală .lumen (logo cu grila Braille, temă închisă implicită, Poppins/JetBrains Mono, butoane pill) și, fiind tehnologie asistivă, e utilizabilă complet din tastatură și cu cititor de ecran.
