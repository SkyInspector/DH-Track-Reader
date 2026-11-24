# DH Track Reader

DH Track Reader est une application web statique pour visualiser une session de descente à partir d’un export RaceBox ou Dragy. Elle affiche le parcours GPS, les données de vitesse et les principaux indicateurs de la session.

## Fonctionnalités

- Affichage du parcours sur un fond satellite ou une carte routière.
- Trace colorée en fonction de la vitesse, avec réglage des seuils.
- Calcul de la distance GPS, de la durée et des altitudes min/max.
- Détection et affichage des points VMax/VMin et des zones de freinage ou de slide.
- Graphique de vitesse interactif : sélection d’un point, zoom, déplacement et lissage de la courbe.
- Affichage des données de télémétrie disponibles : altitude, pente, gyroscope et accélération.
- Chargement d’un fichier CSV par sélection ou glisser-déposer.
- Enregistrement local de Spots (départ/arrivée GPS) et vue Chrono recoupée sur un Spot reconnu.

## Lancer l’application

Le projet ne nécessite ni compilation ni installation de dépendances locales.

1. Ouvrir `DHTrackReader.html` dans un navigateur récent, ou démarrer un serveur web local depuis le dossier du projet :

   ```bash
   python -m http.server 8000
   ```

2. Avec le serveur local, ouvrir [http://localhost:8000/DHTrackReader.html](http://localhost:8000/DHTrackReader.html).
3. Charger un fichier `.csv` avec le bouton prévu à cet effet ou en le déposant dans la zone de chargement.

Une connexion Internet est nécessaire pour charger les bibliothèques et les fonds de carte externes. Le chargement d’un CSV depuis le sélecteur du navigateur est effectué localement ; les tuiles cartographiques sont, elles, demandées à leurs fournisseurs.

### Charger un fichier depuis une URL

L’application accepte également un paramètre `file` pointant vers un fichier accessible depuis le même serveur :

```text
http://localhost:8000/DHTrackReader.html?file=sessions/ma-session.csv
```

Cette méthode nécessite un serveur HTTP ; l’ouverture directe du fichier HTML ne permet généralement pas de récupérer un autre fichier avec `fetch`.

## Formats de fichiers pris en charge

### Export RaceBox

Le fichier doit contenir un en-tête CSV avec les colonnes suivantes (la casse n’est pas importante) :

```text
Record,Time,Latitude,Longitude,Altitude,Speed,...,GyroX,GyroY,GyroZ
```

Les colonnes `Time`, `Latitude`, `Longitude`, `Altitude`, `Speed`, `GyroX`, `GyroY` et `GyroZ` sont requises. Les lignes de métadonnées éventuelles peuvent précéder l’en-tête.

### Export Dragy

Le fichier doit contenir une ligne `[data]`, suivie de mesures séparées par des espaces. Les sept premières valeurs de chaque ligne doivent respecter cet ordre :

```text
Record Time Latitude Longitude Speed Heading Altitude
```

Exemple :

```text
[data]
0 120000.00 46.5000 6.3000 32.5 180 500
1 120001.00 46.5001 6.3001 34.0 181 501
```

Les coordonnées sont détectées automatiquement : degrés décimaux, degrés/minutes ou minutes totales. Pour les deux formats, les vitesses doivent être en km/h et les altitudes en mètres ; les axes du gyroscope sont interprétés en degrés par seconde.

## Utilisation

- **Menu supérieur** : les sections « CARTE », « RUN PREVIEW » et « SPOT LIST » sont indiquées en haut de la page. « HIDE » masque la barre ; « SHOW MENU » la réaffiche.
- **Carte** : basculer entre le fond satellite et le fond routier, orienter la carte avec la boussole ou activer le suivi du rider.
- **Trace** : ajuster les seuils de vitesse qui déterminent ses couleurs.
- **VMax/VMin** : modifier la variation minimale de vitesse pour régler la détection des segments.
- **Graphique** : cliquer ou déplacer le curseur pour consulter la télémétrie ; zoomer avec la molette, déplacer la vue en faisant glisser le graphique et régler les limites de la session avec les poignées.
- **Freinages et marqueurs** : afficher ou masquer les couches correspondantes depuis le panneau latéral.
- **Spots** : en Vue fichier CSV, recouper le run avec les poignées du graphique, puis choisir « Enregistrer le Spot ». Les Spots et leurs coordonnées restent stockés dans le navigateur utilisé. Si le parcours chargé passe près des points de départ et d’arrivée d’un Spot (moins de 1 500 m chacun, dans le bon ordre), son bouton apparaît en bas à gauche. Le sélectionner ouvre la Vue Chrono recoupée sur ces points et affiche les détails du Spot ; la flèche du panneau revient à la liste et à la trace CSV complète. La description et les informations générales affichées sont provisoires.
- **Spot List** : ouvrir « SPOT LIST » depuis le menu supérieur pour afficher tous les Spots enregistrés sur une carte et dans une liste latérale. Les étiquettes des points sont masquables avec le bouton dédié. La liste peut être filtrée par recherche et triée par nom, emplacement, difficulté, revêtement ou date d’ajout.
- **Fichiers partagés** : chaque Spot est enregistré comme un fichier JSON individuel dans le dossier `Spots`. Depuis Spot List, « Dossier Spots » sélectionne ce dossier et mémorise l'accès dans le navigateur. Les nouveaux Spots y sont automatiquement écrits sous forme de `<nom-du-spot>.json`. L’import ajoute des fichiers séparés ; l’export télécharge les Spots un par un. Un dossier vide ne contient aucun Spot.

Les zones de freinage modéré sont affichées en bleu. Les zones de slide détectées sont affichées en violet, notamment lorsque le GyroZ dépasse le seuil utilisé par l’application.

## Structure du projet

| Fichier | Rôle |
| --- | --- |
| `DHTrackReader.html` | Structure de la page et chargement des bibliothèques |
| `DHTrackReader.css` | Mise en page et styles |
| `DHTrackReader.js` | Lecture et analyse des fichiers, carte, graphique et interactions |

## Dépendances et attribution

Les bibliothèques sont chargées depuis un CDN, sans gestionnaire de paquets :

- [Leaflet 1.9.4](https://leafletjs.com/) pour la carte.
- [Leaflet.Rotate 0.2.8](https://github.com/Raruto/leaflet-rotate) pour l’orientation de la carte.

Les fonds satellite et routier utilisent les services ArcGIS d’Esri. L’attribution fournie par Esri est affichée sur la carte.

## Données personnelles

Les fichiers GPS peuvent révéler des lieux et des habitudes de déplacement. Éviter de versionner ou de publier des sessions réelles sans avoir vérifié qu’elles ne contiennent pas de données personnelles.
