# ReconformMC — v2.4.7

Plugin UXP para **Premiere Pro 25.6 o más nuevo** (Windows y Mac).

## Qué hace

Reconforma una edición para que use **Multicamera Source Sequences** o **merged clips** en lugar de los master clips sueltos, por ejemplo para tener el sonido sincronizado en toda la edición. Siempre trabaja **sobre una copia** de la secuencia: el original no se toca.

Tiene cuatro modos:

| Modo | Qué hace | Resultado |
|---|---|---|
| **Master clip → Multicam** | Busca cada master clip de la edición dentro de las multicams del proyecto | Secuencia nueva `«nombre» - MC` |
| **Master clip → Merged** | Lo mismo, contra los merged clips del proyecto | Secuencia nueva `«nombre» - Merged` |
| **Merged → Multicam** | Lee qué video y qué sonido tiene cada merged de la edición y los busca en las multicams | Secuencia nueva `«nombre» - MC` |
| **Flatten** | Desarma los merged clips en video y sonido sueltos | — |

Cada modo tiene un paso de **Analizar**, que solo lee y muestra qué va a encontrar, y un paso de **Reconformar**.

El matcheo es por **archivo**: nombre de origen (sin extensión) y timecode. Así un `.mp4` de la edición encuentra el `.mov` o `.mxf` de la multicam aunque esté en otra carpeta o arranque en otro punto. Sin XML, sin preguntas y sin copias del proyecto: los merged se leen con la API de Premiere y, si no se puede, del `.prproj` guardado.

## Instalación

Doble clic en `ReconformMC_2.4.7.ccx` (en la carpeta `descargas/`) con Premiere cerrado. En Premiere: Ventana > Extensiones > ReconformMC.

## Contenido

| Archivo | Para qué |
|---|---|
| `plugin/main.js` | Panel y conexión con Premiere (UXP) |
| `plugin/reconform-core.js` | Motor de matcheo (independiente de Premiere; escrito en ES3 para correr también en ExtendScript) |
| `plugin/index.html` | Interfaz del panel |
| `plugin/manifest.json` | Manifiesto del plugin |
| `plugin/pako_inflate.min.js` | Librería de terceros (pako, licencia MIT) para leer el `.prproj` comprimido |

## Descargas (listo para usar)

El plugin listo para instalar (`ReconformMC_2.4.7.ccx`) está en la carpeta **`descargas/`**.
