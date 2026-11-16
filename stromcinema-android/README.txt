STROM - Grid layout, update 3  (on top of strom-update-grid2.zip; only 2 files change)

1. The grid now scrolls in whole rows: the first visible row always has the same gap under the tabs, in Movies and
   TV series, and no row is cut off at the top.
2. In the choices card (Play / Info / Audio / Subtitles) Up / Down now jump to the button row above / below;
   Left / Right still move one button.

INSTALL
Copy strom-tv\src\Library.jsx and tv.css into tvapp\src, then in tvapp:  npm run sync  (rebuild the APK).
Desktop: copy tvapp\dist into desktop\web, then  npm run pack:win
