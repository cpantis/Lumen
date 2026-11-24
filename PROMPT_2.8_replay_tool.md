# Prompt – Aplicație web de replay (sub-challenge 2.8, dotLumen SW Test Challenge v4)

> Copiază tot ce e sub linie într-un asistent de programare (Claude Code etc.).

---

## Rol și context

Ești un inginer software senior, cu experiență în ROS 2, vizualizare de date de la senzori și aplicații web performante. Construiește de la zero o **aplicație web de replay** pentru o înregistrare ROS 2 în format **MCAP**, făcută cu ochelarii .lumen (dispozitiv purtabil care ghidează persoane nevăzătoare sau cu deficiențe de vedere) în timp ce utilizatorul mergea pe stradă.

Înregistrarea conține mai multe fluxuri de date:
- **intrări**, produse de senzorii ochelarilor (de exemplu două camere cu câmpuri vizuale diferite: una orientată înainte, alta în jos spre sol, plus, posibil, IMU, adâncime/stereo, `CameraInfo`, `TF`);
- **ieșiri**, produse de o componentă software nedocumentată care combină unele intrări și scoate un al treilea tip de date pentru **două câmpuri vizuale (FOV)**, fiecare cu mai multe tipuri de ieșire.

Nu ai documentație, nu ai codul componentei și nu ai voie să presupui nume de topicuri sau tipuri de mesaje. **Aplicația trebuie să descopere singură** topicurile, tipurile și schemele din fișier.

**Scopul aplicației:** o persoană trebuie să poată vedea, **în orice moment al înregistrării**, ce a intrat în componentă și ce a ieșit din ea, cu toate fluxurile sincronizate în timp.

**Cine o folosește:** inginerii de test, dezvoltatorii și product managerii .lumen. Trebuie să arate și să se comporte ca un **produs intern profesional .lumen**, în linie cu identitatea de pe https://www.dotlumen.com/ro, nu ca un prototip de hackathon. Trebuie să poată fi prezentată unui client sau unui investitor fără jenă.

## Identitate vizuală (extrasă de pe dotlumen.com și din logo-ul din documentul challenge-ului)

**Ton și poziționare.** .lumen se prezintă ca „Inteligență Artificială Pietonală” (*Pedestrian Autonomous Driving AI*), „cea mai avansată tehnologie asistivă din lume” și „conducerea automată redusă la ceva ce poți purta”. Ochelarii „reproduc caracteristicile principale ale unui câine ghid”. Stilul este sobru, tehnologic și încrezător, fără ornamente. În aplicație folosește aceeași terminologie: *Ochelari .lumen*, *Pedestrian AI*, *câmp vizual (FOV)*, *intrări senzori* / *ieșiri componentă*.

**Logo.** Numele se scrie **`.lumen`**, mereu cu litere mici și cu punct în față. Simbolul este o grilă de 3 × 4 puncte în stil Braille: puncte gri `#B2B2B2`, iar câteva puncte și textul în aproape-negru `#161619`. Wordmark-ul are un font geometric subțire, cu linie fină și rotunjită.
- Recreează logo-ul ca **SVG inline** (grila de puncte + „.lumen”), în variantă albă pentru tema închisă și neagră pentru tema deschisă.
- Folosește grila Braille și ca motiv discret: animație de încărcare (punctele se aprind pe rând), favicon, empty states.

**Paletă (tokenuri CSS pe `:root`).**

| Token | Rol | Temă închisă (implicită) | Temă deschisă |
|---|---|---|---|
| `--bg` | fundal aplicație | `#000000` | `#FFFFFF` |
| `--surface` | panouri | `#0E0E10` | `#F5F5F5` |
| `--surface-2` | carduri / hover | `#161619` | `#E8EAED` |
| `--border` | linii subțiri | `#2A2A2E` | `#E3E3E3` |
| `--text` | text principal | `#FFFFFF` | `#161619` |
| `--text-muted` | text secundar | `#8F8F8F` | `#4F4F4F` |
| `--dot` | puncte logo / neutru | `#B2B2B2` | `#979797` |
| `--accent` | acțiune principală, cursor timeline, focus | `#77E8CA` (mentă) | `#00263D` (bleumarin) |
| `--accent-2` | link-uri, selecție, al doilea FOV | `#384AD3` | `#384AD3` |
| `--ok` / `--warn` / `--error` | stări | `#77E8CA` / `#FFCB05` / `#ED1C24` | `#1E8A6E` / `#B38A00` / `#C8102E` |

Culorile de stare se folosesc **numai pentru stare**, nu decorativ. Intrările și ieșirile primesc fiecare câte o culoare constantă în toată aplicația, aceeași pe timeline, în antetul panourilor și în grafice (de exemplu intrări = `--dot`, FOV 1 = `--accent`, FOV 2 = `--accent-2`).

**Tipografie.** Site-ul folosește un font geometric subțire, cu Poppins (ExtraLight / SemiBold) și DIN Next Light ca alternative. În aplicație:
- titluri: **Poppins 200–300**, mari și aerisite;
- etichete și butoane: **Poppins 500–600**;
- valori numerice, timestamp-uri și ID-uri de topic: **JetBrains Mono** (sau `ui-monospace`), cu `font-variant-numeric: tabular-nums`, ca cifrele să nu „sară” la redare.

Fonturile se încarcă din Google Fonts.

**Layout și componente.**
- Stil minimalist, mult spațiu negativ, grilă de 8 px, linii de 1 px în loc de umbre, colțuri mici (6–8 px) pe panouri.
- Butoane **pill** (`border-radius: 50px`), ca pe site: cel principal plin cu `--accent` și text negru, cel secundar cu contur subțire.
- Bară de sus neagră și simplă: logo `.lumen` în stânga, numele fișierului încărcat și durata în centru, iar în dreapta comutator de temă, ajutor (`?`) și setări.
- Iconițe line, subțiri și consistente (Lucide).
- Animații scurte (150–200 ms), dezactivate la `prefers-reduced-motion`.

**Accesibilitate (obligatoriu — .lumen face tehnologie asistivă și are pe site o *Declarație de accesibilitate*).**
- **WCAG 2.2 AA**: contrast ≥ 4.5:1 pentru text și ≥ 3:1 pentru elemente grafice, verificat automat (axe-core în testele Playwright).
- Totul se poate folosi din tastatură: ordine logică a focusului, inel de focus vizibil `--accent` de 2 px, skip link.
- Elementele interactive au ARIA corect. Timeline-ul este un `slider` cu `aria-valuetext` în format citibil („12,4 secunde din 95”).
- Mod **contrast ridicat** și scalare a textului până la 200% fără ca layout-ul să se strice.
- Starea nu e transmisă **niciodată doar prin culoare**: fiecare stare are și o iconiță sau un text (OK / Expirat / Gol / Invalid).
- O regiune `aria-live` anunță evenimentele importante în timpul redării (de exemplu „gol de date pe /camera/front: 340 ms”).

**Interfață în română, cu opțiune EN** (i18n cu fișiere de traduceri), ca pe site.

## UX profesional
- **Ecran de start** curat: logo, titlul „Replay — Ochelari .lumen”, o zonă mare de drag & drop și lista ultimelor fișiere deschise (numai numele, din `localStorage`).
- **Stări complete** pentru fiecare ecran: încărcare (skeleton + grila Braille animată), gol, eroare cu mesaj clar și acțiune propusă, succes.
- **Paletă de comenzi** (Ctrl/⌘ + K) pentru salt la topic, timestamp sau eșec de test și schimbarea layoutului. Lista comenzilor rapide se deschide cu `?`.
- **Tooltips** pe fiecare control și un **tur ghidat** la prima utilizare (3–5 pași, care poate fi sărit).
- **Inspector lateral**, care poate fi ascuns, cu detaliile mesajului selectat: header, stamp, dimensiune, câmpuri.
- Toate unitățile sunt afișate explicit (ms, Hz, m, m/s², rad/s), iar numerele sunt formatate consecvent.
- Interfața se adaptează la ecrane de la 1280 px la 4K. Pe tabletă sau telefon rămâne utilizabilă în modul vizualizare (un singur panou + timeline).

## Constrângeri tehnice

- **Nu se instalează ROS.** Citirea se face direct din MCAP.
- Recomandat: aplicație 100% client-side, **TypeScript + React + Vite**:
  - `@mcap/core` pentru citire indexată (`McapIndexedReader`) dintr-un `File`/`Blob` încărcat prin drag & drop, fără să fie citit tot fișierul în memorie (înregistrarea poate avea câțiva GB);
  - `@foxglove/rosmsg` + `@foxglove/rosmsg2-serialization` pentru decodare CDR pe baza schemelor `ros2msg` din fișier (cu suport și pentru `ros2idl` dacă apare);
  - `three.js` (sau `@react-three/fiber`) pentru 3D, Canvas 2D/WebGL pentru imagini, `uPlot` (sau echivalent) pentru serii de timp.
- Decodarea și indexarea rulează în **Web Workers**, ca UI-ul să nu se blocheze. Folosește un cache LRU de mesaje decodate și prefetch în jurul cursorului de timp.
- Ținte de performanță: interfața rămâne fluidă (≥ 30 fps la redare 1×) cu toate panourile deschise; un salt la un timestamp oarecare se face în < 500 ms.
- Pornire cu o singură comandă: `npm install && npm run dev`, plus un `Dockerfile` sau `npm run build` care produce un site static.
- Alternativă acceptată, dacă browserul nu face față volumului: un backend Python (FastAPI + `mcap` + `mcap-ros2-support`) care indexează fișierul și servește mesajele decodate sau imaginile pe endpointuri, cu același frontend. Justifică alegerea în README.

## Funcționalități obligatorii

### 1. Încărcare și inventar
- Drag & drop sau selectare de fișier `.mcap`, cu bară de progres la indexare.
- Tabel de inventar: topic, tip de mesaj, encoding, număr de mesaje, frecvență medie, jitter (deviația standard a intervalului dintre mesaje), cel mai mare gol, primul și ultimul timestamp.
- Fiecare topic primește o clasificare **Intrare / Ieșire / Necunoscut**, cu o euristică propusă automat: tipuri de senzor (`Image`, `CompressedImage`, `Imu`, `CameraInfo`) → intrare; restul → ieșire candidat. Utilizatorul o poate edita, iar clasificarea și asocierea fiecărui topic cu un FOV se salvează în `localStorage` și se pot exporta sau importa ca JSON.

### 2. Timeline și control al redării
- Play / pause, viteze 0.1× … 4×, buclă pe un interval selectat, pas înainte și înapoi **cu un cadru pentru un topic ales** (de exemplu „următorul mesaj de pe topicul de ieșire X”).
- Bară de scrub cu un rând per topic, pe care fiecare mesaj apare ca o bifă. **Golurile** (interval > k × perioada mediană, cu k configurabil, implicit 2) sunt evidențiate cu roșu; mesajele goale sau invalide au altă culoare.
- Afișarea timpului curent atât absolut (UTC, ns), cât și relativ la începutul înregistrării.
- Comenzi din tastatură: Space, ←/→ (cadru), Shift+←/→ (±1 s), `[` `]` (viteză).
- Starea se salvează în URL (timp curent, layout, topicuri vizibile), ca un anumit moment să poată fi trimis printr-un link.

### 3. Sincronizare
- Selector pentru sursa timpului: **log time** (momentul înregistrării în bag) sau **`header.stamp`** (momentul de achiziție sau procesare, acolo unde există).
- Pentru fiecare panou se afișează ultimul mesaj cu timestamp ≤ timpul curent, împreună cu **vârsta** lui (t_curent − t_mesaj). Panoul devine portocaliu sau roșu când vârsta depășește 1,5× sau 3× perioada nominală a topicului (date expirate).
- **Asocierea ieșire → intrare:** pentru mesajul de ieșire curent se caută intrările folosite, prin potrivire exactă de `header.stamp` sau, dacă nu există, prin cea mai apropiată intrare anterioară. Se afișează **latența** (log_time ieșire − stamp intrare) și se evidențiază cadrele de intrare corespunzătoare în panourile lor.
- Afișaj live al latenței și un mini-grafic al latenței pe toată înregistrarea, cu cursor sincronizat.

### 4. Panouri de vizualizare (alese automat după tipul mesajului)
- `sensor_msgs/Image` și `CompressedImage`: afișare corectă pentru encodingurile `rgb8`, `bgr8`, `mono8`, `mono16`, `16UC1`, `32FC1` (adâncime cu colormap configurabil și interval min/max), JPEG/PNG. Pixelul de sub cursor își arată valoarea reală, inclusiv în unități.
- `sensor_msgs/PointCloud2`: vizualizare 3D (orbit camera), colorare după x, y, z, intensitate sau orice câmp, dimensiune configurabilă a punctelor, afișarea numărului de puncte și a procentului de puncte NaN sau invalide.
- `nav_msgs/OccupancyGrid`, `sensor_msgs/LaserScan`, `visualization_msgs/Marker(Array)`, `geometry_msgs/*Stamped`: randare 2D sau 3D adecvată.
- `sensor_msgs/Imu`: grafice pentru accelerație, viteză unghiulară și orientare (roll, pitch, yaw), cu cursorul de timp sincronizat.
- `tf2_msgs/TFMessage` (`/tf`, `/tf_static`): arborele de frame-uri și axele afișate în scena 3D.
- `CameraInfo`: rezoluție, K, D, P, afișate ca text.
- **Fallback generic** pentru orice alt tip: arbore JSON al mesajului, plus posibilitatea de a reprezenta grafic **orice câmp numeric** ca serie de timp, prin selectarea căii (de exemplu `msg.data[3]`).

### 5. Layout orientat pe componentă
- Layout implicit în trei coloane: **Intrări | Ieșiri FOV 1 | Ieșiri FOV 2**, cu panouri redimensionabile și rearanjabile (de exemplu cu `react-grid-layout`). Layoutul se poate salva și încărca.
- Antetul fiecărui panou arată: topicul, tipul, frecvența, vârsta mesajului, indexul mesajului (n / N) și starea (OK / expirat / gol / invalid).

### 6. Suprapuneri pentru verificarea consistenței (legat de 2.3)
- Proiectarea ieșirii 3D a unui FOV (point cloud sau adâncime) **peste imaginea camerei** corespunzătoare, folosind `CameraInfo` și `TF`. Dacă lipsesc, aplicația permite introducerea manuală a intrinsecilor sau extrinsecilor (fx, fy, cx, cy, translație, rotație), cu valori salvate și exportabile.
- Comparație vizuală între două ieșiri ale aceluiași FOV pentru același moment: overlay cu transparență reglabilă și o hartă de diferențe, acolo unde au aceeași geometrie.

### 7. Integrare cu raportul de teste (legat de 2.4)
- Import al unui fișier JSON cu eșecuri de forma `[{ "requirement": "REQ-xx", "topic": "...", "t_start_ns": ..., "t_end_ns": ..., "measured": ..., "limit": ..., "message": "..." }]`.
- Eșecurile apar ca markere pe timeline și într-o listă laterală; un click pe eșec face salt la momentul respectiv.
- Bookmarkuri manuale cu notă, exportabile ca JSON.

### 8. Export
- Captură PNG a întregului layout la momentul curent.
- Export al unui interval ca video WebM (prin `MediaRecorder` pe canvas compus), opțional.
- Export CSV pentru seriile reprezentate grafic.

## Funcții pentru un Senior Test Engineer (legate de fiecare sub-challenge)

Documentul challenge-ului cere ca **fiecare afirmație să fie susținută de o măsurătoare**: „We value curiosity, rigour and evidence”. Aplicația trebuie să fie instrumentul care produce acea dovadă, nu doar un player video. Pentru fiecare sub-challenge adaugă:

### 2.1 – Înțelegerea înregistrării
- **Raport de inventar exportabil** (Markdown și CSV), gata de lipit în document: topic, tip, encoding, rezoluție sau dimensiune, `frame_id`, unități, număr de mesaje, Hz mediu / median / min / max, jitter, cel mai mare gol, clasificare I/O și **motivul** clasificării.
- Pentru fiecare topic:
  - **histograma intervalelor dintre mesaje** și **graficul frecvenței instantanee în timp**, ca regularitatea să se vadă pe toată înregistrarea;
  - o **miniatură reprezentativă** (imagine, nor de puncte sau grafic), pentru secțiunea „visual” din document.
- **Analiza ceasurilor**, pentru fiecare topic:
  - diferența `log_time − header.stamp` în timp;
  - stamp-uri nemonotone, duplicate, ieșite din ordine sau din viitor;
  - pentru topicurile fără `header`, se notează că lipsește.

### 2.2 – Documentarea componentei
- **Inferență automată a cauzalității I/O:** pentru fiecare ieșire se caută ce intrare are `header.stamp` identic sau cel mai apropiat anterior și cu ce rată de potrivire. Din asta se generează **diagrama I/O** (Mermaid sau SVG, exportabilă), cu procentul de potrivire pe fiecare săgeată. Așa se dovedește, nu doar se presupune, ce intrări produc ce ieșiri.
- **Analiză de latență**, pentru fiecare pereche intrare → ieșire:
  - histogramă, percentile p50 / p90 / p95 / p99 / max și latență în timp;
  - definiția exactă a latenței afișată lângă grafic (de exemplu `log_time(ieșire) − header.stamp(intrare)`).
- **Rata de procesare și pierderile:** câte cadre de intrare **nu au** ieșire corespunzătoare (cadre sărite), raportul dintre rata de ieșire și rata de intrare, și secvențele lungi de cadre sărite marcate pe timeline.
- **Unealtă de măsurare cu cursoare A/B** pe timeline: Δt, număr de mesaje per topic și frecvență în interval. Rezultatul se poate copia ca text pentru document.
- **Ciornă de cerințe:** din valorile măsurate, aplicația propune praguri (de exemplu „frecvența ieșirii FOV 1 ≥ p1 din măsurat”). Ciorna se exportă ca tabel cu ID unic (`REQ-xxx`), enunț, criteriu de acceptare și metodă de verificare. Ultima decizie aparține inginerului, aplicația doar propune.

### 2.3 – Consistența ieșirilor între ele
- Pentru fiecare FOV: **gruparea ieșirilor care descriu același moment** (același stamp), cu indicator vizual când una dintre ele lipsește.
- **Metrici de concordanță** calculate pe fiecare cadru și reprezentate în timp: de exemplu, punctele 3D proiectate care cad în afara imaginii sau a măștii, diferența de adâncime între două reprezentări și procentul de acoperire.
- **Estimarea informației lipsă** (intrinseci și extrinseci):
  - câmpuri editabile cu **eroarea de reproiecție recalculată live**;
  - posibilitatea de a rula o optimizare simplă (grid search sau Nelder–Mead) pe parametrii necunoscuți;
  - **intervalul de încredere** al estimării afișat (sensibilitatea metricii la ±δ pe fiecare parametru);
  - parametrii estimați exportați ca JSON, pentru a fi refolosiți în testele automate.

### 2.4 – Testarea automată
- **Două profiluri de praguri**, *Derivat* (din 2.2) și *Strict* (final). Se comută dintr-un click, iar pragurile se citesc din același fișier YAML/JSON pe care îl folosesc scripturile de test, ca să existe **o singură sursă de adevăr**.
- **Linii de prag** desenate pe toate graficele. Intervalele care încalcă pragul sunt **hașurate pe timeline**, cu valoarea depășirii („+38 ms peste limită”).
- **Metrici de conținut pe fiecare mesaj**, nu doar sosirea lui:
  - procent NaN, Inf și zero, valori min / max / medie, puncte în afara intervalului plauzibil;
  - mesaje goale, dimensiune neschimbată sau aberantă, cadre identice repetate (hash);
  - toate reprezentate în timp și cumulate per topic.
- **Comparație de rapoarte:** import al rapoartelor *Derivat* și *Strict* în paralel. Diferențele PASS → FAIL sunt evidențiate per cerință, cu salt la momentele în care eșuează.
- **Validare încrucișată:** metricile calculate în aplicație trebuie să coincidă cu cele din scripturile de test, în limita unei toleranțe. Un ecran „Verificare consistență” le compară și semnalează diferențele.

### 2.5 – Ce înseamnă pentru utilizator
- **Context de mișcare:** viteza de mers a utilizatorului, estimată din IMU (numărare de pași sau integrare cu filtrare) sau, dacă nu se poate estima, presupusă la 1,4 m/s și editabilă. Presupunerea apare în UI.
- **Traducerea timpului în metri, peste tot:** lângă orice latență sau gol se afișează și **distanța parcursă** de utilizator („latență 180 ms ≈ 25 cm parcurși”, „gol de 600 ms ≈ 84 cm fără informație”).
- O vedere **„Siguranță”** care arată doar cerințele marcate *safety-critical* și cele mai grave momente din înregistrare, ordonate după distanța parcursă „orbește”.

### 2.6 – Raportarea problemelor
- Buton **„Creează bug”** la momentul curent sau pentru intervalul A/B. Generează un raport Markdown (format de bug tracker) cu:
  - titlu, severitate (selectabilă, cu justificare), cerința afectată;
  - intervalul exact în ns și secunde relative, valorile măsurate față de cele așteptate;
  - **capturi PNG** și grafice atașate;
  - **pași de reproducere**: deep-link în aplicație, plus comanda CLI a testului care reproduce eșecul.
- Bug-urile salvate apar ca markere pe timeline și se exportă împreună (ZIP: Markdown + imagini).

### 2.7 – Întrebări pentru dezvoltator
- **Note și întrebări ancorate în timp**, cu tag-uri (`întrebare`, `presupunere`, `anomalie`) și prioritate. Se exportă ca listă ordonată, cu link la momentul din înregistrare.
- Un **registru de presupuneri**, actualizat automat cu tot ce aplicația a presupus (viteza de mers, intrinseci estimate, praguri). Documentul cere explicit: „State your assumptions explicitly”.

### Trasabilitate și reproductibilitate
- Pe ecran și în orice export apar: **SHA-256 al fișierului MCAP**, versiunea aplicației (git commit), profilul de praguri și parametrii estimați folosiți. Oricine trebuie să poată reproduce exact aceeași imagine sau același raport.
- Toate calculele sunt deterministe, fără eșantionare aleatoare. Dacă se face decimare pentru performanță, aceasta se indică vizibil, iar metricile se calculează mereu pe date complete.

## Prioritizare (bugetul total al challenge-ului este de 10 ore, iar 2.8 este opțional)
Construiește în ordinea de mai jos. Fiecare nivel trebuie să fie **complet funcțional și livrabil** înainte de a trece la următorul:
- **P0 (MVP, ~2–3 h):** încărcare MCAP, inventar, timeline sincronizat cu play/scrub, panouri pentru imagini și nori de puncte, fallback generic, vârsta mesajelor, golurile, identitatea vizuală de bază.
- **P1:** asocierea ieșire → intrare cu latența, import al raportului de teste cu markere, profilurile *Derivat* / *Strict* cu linii de prag, metricile de conținut, distanța parcursă, cursoarele A/B.
- **P2:** overlay-urile de proiecție cu estimarea parametrilor, „Creează bug”, notele și registrul de presupuneri, comparația de rapoarte, exportul video, tur ghidat, i18n EN.

## Robustețe
- Aplicația nu se blochează la mesaje corupte, scheme lipsă, encodinguri necunoscute sau topicuri fără `header`. Un astfel de mesaj apare ca „nu pot decoda” și se continuă cu restul.
- Fișiere neindexate sau trunchiate: fallback pe citire secvențială (`McapStreamReader`) cu avertisment.
- Nimic nu e hardcodat: nume de topicuri, frame-uri, rezoluții și număr de FOV-uri se deduc din fișier sau din configurația utilizatorului.

## Calitate și livrabile
- Cod TypeScript strict, modular (`reader/`, `decode/`, `sync/`, `panels/`, `timeline/`, `state/`), cu JSDoc pe funcțiile publice.
- **Teste unitare** (Vitest) pentru logica critică: căutarea ultimului mesaj ≤ t (binary search), detectarea golurilor, calculul frecvenței și jitterului, asocierea ieșire → intrare după stamp, decodarea encodingurilor de imagine. Adaugă un mic fișier MCAP sintetic, generat de un script din repo, pentru teste reproductibile.
- Un **test end-to-end** (Playwright): încarcă MCAP-ul sintetic, rulează play, face scrub și verifică faptul că panourile se actualizează. Include și un audit de accesibilitate cu `@axe-core/playwright` (zero încălcări serioase), în ambele teme.
- Capturi de ecran în temele închisă și deschisă, incluse în README.
- `README.md` cu: arhitectura (diagramă), cum se rulează (o singură comandă), cum se folosește (GIF sau capturi), limitări cunoscute și presupuneri.
- Un paragraf gata de inclus în secțiunea „Implementation” a documentului challenge-ului, care descrie tool-ul, deciziile tehnice și cum ajută la analiza componentei.

## Mod de lucru
0. Definește întâi **design system-ul** (tokenuri CSS, tipografie, butoane, panou, antet de panou, badge-uri de stare, logo SVG) într-o pagină `/styleguide`, ca să poată fi verificat vizual înainte de restul aplicației.
1. Continuă cu un script de inspecție care listează topicurile, tipurile, schemele și statisticile din fișierul real, ca să confirmi ce trebuie suportat.
2. Implementează incremental, pe nivelurile P0 → P1 → P2 de mai sus: reader + inventar → timeline + sincronizare → panouri de imagine → 3D → asociere ieșire → intrare și latență → import de raport și praguri → suprapuneri → bug-uri și export. Logica de calcul (frecvență, goluri, latență, metrici de conținut) stă într-un modul pur, fără UI, testat unitar și reutilizabil din CLI (`npm run metrics -- file.mcap --out metrics.json`), pentru validarea încrucișată cu scripturile de test.
3. După fiecare etapă, rulează testele și verifică vizual în browser.
4. Declară explicit orice presupunere făcută acolo unde datele nu spun ceva.
