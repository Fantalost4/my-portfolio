import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.152.2/build/three.module.js';
import { FontLoader } from 'https://cdn.jsdelivr.net/npm/three@0.152.2/examples/jsm/loaders/FontLoader.js';
import { TextGeometry } from 'https://cdn.jsdelivr.net/npm/three@0.152.2/examples/jsm/geometries/TextGeometry.js';

window.addEventListener('DOMContentLoaded', () => {
  'use strict';

  const canvas = document.querySelector('.webgl');
  const fallbackTitle = document.querySelector('.webgl-fallback-title');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0, 9);

  const textScene = new THREE.Scene();
  const scene = textScene;
  scene.fog = new THREE.FogExp2(0xFFF0F5, 1.5);
  const backgroundScene = new THREE.Scene();
  const fluidScene = new THREE.Scene();
  const postScene = new THREE.Scene();
  const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeometry = new THREE.PlaneGeometry(2, 2);

  // Pink liquid background: animated fbm noise, soft bubbles and fluid pressure displacement.
  const backgroundUniforms = {
    uTime: { value: 0 },
    uFluidTexture: { value: null },
    uMouse: { value: new THREE.Vector2(0.5, 0.5) },
    uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) }
  };
  const backgroundMaterial = new THREE.ShaderMaterial({
    uniforms: backgroundUniforms,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform sampler2D uFluidTexture;
      uniform vec2 uMouse;
      uniform vec2 uResolution;
      varying vec2 vUv;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }

      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
      }

      float fbm(vec2 p) {
        float value = 0.0;
        float amplitude = 0.5;
        for (int i = 0; i < 5; i++) {
          value += noise(p) * amplitude;
          p = p * 2.0 + vec2(17.2, 9.4);
          amplitude *= 0.5;
        }
        return value;
      }

      void main() {
        vec2 aspectUv = vUv;
        aspectUv.x *= uResolution.x / uResolution.y;
        vec2 fluid = texture2D(uFluidTexture, vUv).rg - vec2(0.5);
        float dist = distance(vUv, uMouse);
        float localRipple = 1.0 - smoothstep(0.0, 0.15, dist);
        vec2 waveUv = aspectUv + fluid * 0.22 * localRipple;
        float liquid = fbm(waveUv * 2.2 + vec2(uTime * 0.025, -uTime * 0.018));
        float slowWave = sin(waveUv.x * 5.0 + uTime * 0.3) * cos(waveUv.y * 4.0 - uTime * 0.24);
        float bubbleOne = exp(-distance(waveUv, vec2(0.42, 0.47)) * 5.0);
        float bubbleTwo = exp(-distance(waveUv, vec2(0.93, 0.22)) * 7.0);
        float lowerWater = 1.0 - smoothstep(0.28, 0.56, vUv.y);
        float waterNoise = fbm(waveUv * 5.0 - vec2(uTime * 0.08, uTime * 0.045));
        float waterMotion = (waterNoise * 0.72 + slowWave * 0.28) * lowerWater;
        vec3 blush = vec3(0.49, 0.27, 0.35);
        vec3 cream = vec3(0.67, 0.43, 0.52);
        vec3 pink = vec3(0.72, 0.28, 0.45);
        vec3 waterTint = vec3(0.38, 0.22, 0.31);
        vec3 color = mix(blush, cream, smoothstep(0.15, 0.82, liquid));
        color = mix(color, pink, smoothstep(0.68, 1.0, liquid + slowWave * 0.08) * 0.2);
        color = mix(color, waterTint, smoothstep(0.18, 0.86, waterMotion) * 0.4);
        color += vec3(1.0, 0.45, 0.7) * (bubbleOne + bubbleTwo) * 0.045;
        float vignette = smoothstep(0.92, 0.22, distance(vUv, vec2(0.5)));
        color *= mix(0.62, 1.0, vignette);
        gl_FragColor = vec4(color, 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false
  });
  backgroundScene.add(new THREE.Mesh(quadGeometry, backgroundMaterial));

  // Two low-resolution render targets form the ping-pong pressure texture.
  const fluidResolution = 256;
  const fluidOptions = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false };
  let fluidRead = new THREE.WebGLRenderTarget(fluidResolution, fluidResolution, fluidOptions);
  let fluidWrite = new THREE.WebGLRenderTarget(fluidResolution, fluidResolution, fluidOptions);
  const fluidUniforms = {
    uPrevious: { value: fluidRead.texture },
    uMouse: { value: new THREE.Vector2(-1, -1) },
    uVelocity: { value: new THREE.Vector2(0, 0) },
    uTime: { value: 0 },
    uDecay: { value: 0.968 }
  };
  const fluidMaterial = new THREE.ShaderMaterial({
    uniforms: fluidUniforms,
    vertexShader: `varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position,1.0);}`,
    fragmentShader: `
      uniform sampler2D uPrevious;
      uniform vec2 uMouse;
      uniform vec2 uVelocity;
      uniform float uTime;
      uniform float uDecay;
      varying vec2 vUv;
      void main(){
        vec2 previous = texture2D(uPrevious, vUv).rg;
        vec2 advected = texture2D(uPrevious, clamp(vUv - (previous - 0.5) * 0.006, 0.001, 0.999)).rg;
        float distanceToMouse = distance(vUv, uMouse);
        float splat = exp(-distanceToMouse * distanceToMouse / 0.0022);
        float ripple = sin(distanceToMouse * 105.0 - uTime * 8.0) * 0.045 * splat;
        vec2 injection = (uVelocity * 0.46 + vec2(ripple, -ripple)) * splat;
        vec2 pressure = mix(advected, vec2(0.5), 1.0 - uDecay) + injection;
        gl_FragColor = vec4(clamp(pressure, 0.0, 1.0), 0.0, 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false
  });
  fluidScene.add(new THREE.Mesh(quadGeometry, fluidMaterial));

  const textTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false });
  const backgroundTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false });
  const textLight = new THREE.AmbientLight(0xffffff, 0.6);
  textScene.add(textLight);
  const directionalLight = new THREE.DirectionalLight(0xfff4fb, 1.8);
  directionalLight.position.set(-4, 5, 4);
  directionalLight.castShadow = true;
  directionalLight.shadow.mapSize.set(2048, 2048);
  directionalLight.shadow.bias = -0.0005;
  directionalLight.shadow.camera.left = -5;
  directionalLight.shadow.camera.right = 5;
  directionalLight.shadow.camera.top = 4;
  directionalLight.shadow.camera.bottom = -4;
  directionalLight.shadow.camera.near = 0.5;
  directionalLight.shadow.camera.far = 20;
  textScene.add(directionalLight);
  const pinkRimLight = new THREE.PointLight(0xff7fb0, 1.1, 12);
  pinkRimLight.position.set(3, -1, 3);
  textScene.add(pinkRimLight);

  let titleMesh;
  const abyssTextGroup = new THREE.Group();
  abyssTextGroup.position.y = -50;
  textScene.add(abyssTextGroup);
  let abyssLineOne;
  let abyssLineTwo;
  let introComplete = false;
  const fontLoader = new FontLoader();
  fontLoader.load('https://cdn.jsdelivr.net/npm/three@0.152.2/examples/fonts/helvetiker_bold.typeface.json', (font) => {
    const textGeometry = new TextGeometry('NEXUS', {
      font,
      size: 0.8,
      height: 0.2,
      curveSegments: 12,
      bevelEnabled: true,
      bevelThickness: 0.03,
      bevelSize: 0.02,
      bevelSegments: 4
    });
    textGeometry.center();
    const textMaterial = new THREE.MeshStandardMaterial({ color: 0xd5d5d5, roughness: 0.4, metalness: 0.2 });
    titleMesh = new THREE.Mesh(textGeometry, textMaterial);
    titleMesh.position.set(0, 0.15, 0);
    titleMesh.scale.set(0, 0, 0);
    titleMesh.castShadow = true;
    titleMesh.receiveShadow = true;
    textScene.add(titleMesh);
    fallbackTitle.classList.add('is-hidden');
    function createAbyssLine(text, y, fontSize) {
      const lineCanvas = document.createElement('canvas');
      lineCanvas.width = 1600;
      lineCanvas.height = 220;
      const lineContext = lineCanvas.getContext('2d');
      lineContext.clearRect(0, 0, lineCanvas.width, lineCanvas.height);
      lineContext.fillStyle = '#ffffff';
      lineContext.font = `600 ${fontSize}px Manrope, Arial, sans-serif`;
      lineContext.textAlign = 'center';
      lineContext.textBaseline = 'middle';
      lineContext.shadowColor = 'rgba(255,255,255,.8)';
      lineContext.shadowBlur = 18;
      lineContext.fillText(text, lineCanvas.width / 2, lineCanvas.height / 2);
      const lineTexture = new THREE.CanvasTexture(lineCanvas);
      lineTexture.minFilter = THREE.LinearFilter;
      lineTexture.magFilter = THREE.LinearFilter;
      const lineMaterial = new THREE.MeshBasicMaterial({ map: lineTexture, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
      const lineMesh = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 0.88), lineMaterial);
      lineMesh.position.set(0, y, 0);
      abyssTextGroup.add(lineMesh);
      return lineMesh;
    }
    abyssLineOne = createAbyssLine('Заказывайте у нас сайты', 0.45, 82);
    abyssLineTwo = createAbyssLine('Instagram: @lost.spriteee', -0.5, 58);
    window.__asterTextReady = true;
    startIntro();
  }, undefined, () => {
    fallbackTitle.classList.remove('is-hidden');
    window.__asterFontFallback = true;
  });

  function startIntro() {
    if (window.__asterIntroStarted) return;
    window.__asterIntroStarted = true;
    const intro = gsap.timeline({
      onComplete: () => {
        introComplete = true;
        window.__asterIntroComplete = true;
        document.querySelector('.ui-container').classList.add('intro-ready');
        gsap.to('.ui-container', { opacity: 1, autoAlpha: 1, duration: 1, ease: 'power1.inOut' });
      }
    });
    intro.to(scene.fog, { density: 0, duration: 3, ease: 'power2.out' }, 0);
    intro.to(titleMesh.scale, { x: 1, y: 1, z: 1, duration: 2.5, ease: 'back.out(1.2)', delay: 0.5 }, 0);
    intro.to(camera.position, { z: 7, duration: 2.5, ease: 'power2.out' }, 0);
    window.__asterIntroTimeline = intro;
  }

  const finalUniforms = {
    uBackgroundTexture: { value: backgroundTarget.texture },
    uTextTexture: { value: textTarget.texture },
    uFluidTexture: { value: fluidRead.texture },
    uMouse: { value: new THREE.Vector2(0.5, 0.5) },
    uTime: { value: 0 },
    uDistortionStrength: { value: 0.12 },
    uTransitionDarkness: { value: 0 }
  };
  const finalMaterial = new THREE.ShaderMaterial({
    uniforms: finalUniforms,
    vertexShader: `varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position,1.0);}`,
    fragmentShader: `
      uniform sampler2D uBackgroundTexture;
      uniform sampler2D uTextTexture;
      uniform sampler2D uFluidTexture;
      uniform vec2 uMouse;
      uniform float uTime;
      uniform float uDistortionStrength;
      uniform float uTransitionDarkness;
      varying vec2 vUv;
      void main(){
        vec2 fluidData = texture2D(uFluidTexture, vUv).rg;
        vec2 fluidOffset = fluidData - vec2(0.5);
        float dist = distance(vUv, uMouse);
        float localRipple = 1.0 - smoothstep(0.0, 0.15, dist);
        vec2 wave = vec2(sin(vUv.y * 44.0 + uTime * 1.7), cos(vUv.x * 39.0 - uTime * 1.5)) * 0.0018;
        vec2 distortedUV = clamp(vUv + (fluidOffset + wave) * uDistortionStrength * localRipple, 0.001, 0.999);
        vec4 backgroundColor = texture2D(uBackgroundTexture, distortedUV);
        vec4 modelsColor = backgroundColor;
        vec4 uiColor = texture2D(uTextTexture, distortedUV);
        // Keep the title clean and stable: no RGB split or colored fringe around the letters.
        uiColor = texture2D(uTextTexture, distortedUV);
        vec4 baseColor = mix(modelsColor, vec4(0.0, 0.0, 0.0, 1.0), uTransitionDarkness);
        vec4 finalColor = mix(baseColor, uiColor, uiColor.a);
        gl_FragColor = finalColor;
      }
    `,
    depthTest: false,
    depthWrite: false
  });
  postScene.add(new THREE.Mesh(quadGeometry, finalMaterial));

  const mouse = { targetX: 0, targetY: 0, uvX: 0.5, uvY: 0.5, velocityX: 0, velocityY: 0, lastX: 0.5, lastY: 0.5, distortionStrength: 0.12, distortionTarget: 0.12 };
  window.addEventListener('mousemove', (event) => {
    const nextX = event.clientX / window.innerWidth - 0.5;
    const nextY = 0.5 - event.clientY / window.innerHeight;
    const nextUvX = event.clientX / window.innerWidth;
    const nextUvY = 1 - event.clientY / window.innerHeight;
    mouse.targetX = nextX;
    mouse.targetY = nextY;
    mouse.uvX = nextUvX;
    mouse.uvY = nextUvY;
    mouse.velocityX = nextUvX - mouse.lastX;
    mouse.velocityY = nextUvY - mouse.lastY;
    mouse.lastX = nextUvX;
    mouse.lastY = nextUvY;
    mouse.distortionTarget = Math.min(0.48, 0.12 + Math.hypot(mouse.velocityX, mouse.velocityY) * 9.0);
  });

  gsap.registerPlugin(ScrollTrigger);
  const lenis = new Lenis({ duration: 1.2, smoothWheel: true, smoothTouch: false });
  let scrollVelocity = 0;
  let scrollVelocityTarget = 0;
  lenis.on('scroll', ScrollTrigger.update);
  lenis.on('scroll', ({ velocity }) => {
    scrollVelocityTarget = velocity;
  });
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);

  const startButton = document.querySelector('.start-btn');
  const tunnelContainer = document.querySelector('.tunnel-container');
  const browserTemplates = [
    '<div class="fake-site-screen browser-mockup site-gastro"><div class="browser-bar"><i></i><i></i><i></i><span>gastro-bistro.ua</span></div><header><b>GASTRO BISTRO</b><button>Особистий кабінет</button><span class="cart">◌</span></header><main><h1>Доставка їжі<br>за 30 хвилин</h1><div class="product-grid"><article><strong>Піца Трюфельна</strong><small>⭐ 4.9</small><b>380 ₴</b><button>В кошик</button></article><article><strong>Рол Філадельфія Люкс</strong><small>⭐ 4.8</small><b>420 ₴</b><button>В кошик</button></article><article><strong>Бургер Black Angus</strong><small>⭐ 5.0</small><b>290 ₴</b><button>В кошик</button></article></div></main></div>',
    '<div class="fake-site-screen browser-mockup site-sport"><div class="browser-bar"><i></i><i></i><i></i><span>aura-fitness.ua</span></div><header><b>AURA FITNESS</b><nav>Послуги　 Тренери　 Ціни</nav><button>Увійти в кабінет</button></header><main><h1>Твій результат<br>починається тут</h1><div class="price-grid"><article><strong>Безлімітний абонемент на 12 місяців</strong><b>18 500 ₴</b></article><article><strong>10 персональних тренувань з Top-інструктором</strong><b>8 000 ₴</b></article><article><strong>Разове відвідування + басейн</strong><b>800 ₴</b><button>Купити карту</button></article></div></main></div>',
    '<div class="fake-site-screen browser-mockup site-fashion"><div class="browser-bar"><i></i><i></i><i></i><span>streetwear.lab</span></div><header><b>STREETWEAR LAB</b><span>⌕ Пошук</span><button>Особистий кабінет</button></header><main><div class="shop-grid"><article><strong>Оверсайз Худі "Blank" Heavy</strong><small>⭐ 4.9 · 124 відгуки</small><b>2 600 ₴</b></article><article><strong>Джогери Карго Black</strong><small>⭐ 4.7</small><b>1 950 ₴</b></article><article><strong>Футболка "Acid Wash"</strong><small>⭐ 4.8</small><b>1 200 ₴</b></article><article><strong>Зимова куртка-пуховик Techwear</strong><small>Знижка -20%</small><b>5 800 ₴</b><button>Купити</button></article></div></main></div>',
    '<div class="fake-site-screen browser-mockup site-auto"><div class="browser-bar"><i></i><i></i><i></i><span>neo-drive.ua</span></div><header><b>NEO DRIVE</b><nav>Авто　 Моделі　 Сервіс</nav></header><main><h1>Новий ексклюзивний<br>електрокросовер в наявності</h1><div class="auto-hero"><strong>NEO X</strong><span>Запас ходу: 650 км　|　0-100 км/ч: 3.8с</span></div><button>Записатися на Тест-Драйв</button><button>Розрахунок в кредит (від 18 000 ₴/міс)</button></main></div>',
    '<div class="fake-site-screen browser-mockup site-realestate"><div class="browser-bar"><i></i><i></i><i></i><span>solid-space.ua</span></div><header><b>SOLID SPACE</b><nav>Купити　 Оренда　 Новобудови</nav></header><main><div class="filter">Купити　|　Оренда　|　Новобудови</div><div class="estate-grid"><article><strong>2-кімнатна квартира в ЖК "Панорама"</strong><small>68 м² · ⭐ 4.9</small><b>2.9 млн ₴</b></article><article><strong>Пентхаус з терасою</strong><small>120 м² · ⭐ 5.0</small><b>6.8 млн ₴</b></article><article><strong>Студія в стилі Лофт</strong><small>35 м²</small><b>1.4 млн ₴</b><button>Дізнатися більше</button></article></div></main></div>',
    '<div class="fake-site-screen browser-mockup site-watches"><div class="browser-bar"><i></i><i></i><i></i><span>chrono-exquisite.com</span></div><header><b>CHRONO EXQUISITE</b><button>Кабінет колекціонера</button></header><main><div class="watch-orbit">HERITAGE</div><h1>Колекція Heritage 2026</h1><p>Лімітована серія — 500 екземплярів</p><b class="lux-price">580 000 ₴</b><button>Залишити заявку</button></main></div>',
    '<div class="fake-site-screen browser-mockup site-resort"><div class="browser-bar"><i></i><i></i><i></i><span>wanderlust-resorts.ua</span></div><header><b>WANDERLUST RESORTS</b><nav>Напрямки　 Вілли　 Про нас</nav></header><main><div class="booking">Дата заїзду　　Гості　　<button>Знайти номер</button></div><div class="hotel-grid"><article><strong>Villa Maldives Luxury 5*</strong><small>⭐ 5.0 · Все включено</small><b>від 18 000 ₴ / ніч</b></article><article><strong>Alpine Chalet Switzerland 4*</strong><small>⭐ 4.8</small><b>від 11 000 ₴ / ніч</b></article><article><strong>Tokyo Cyber Hotel 4*</strong><b>від 7 500 ₴ / ніч</b><button>Забронювати</button></article></div></main></div>',
    '<div class="fake-site-screen browser-mockup site-tech"><div class="browser-bar"><i></i><i></i><i></i><span>nexus-tech.cloud</span></div><header><b>NEXUS TECH</b><span>Особистий кабінет розробника</span></header><main><aside>Dashboard<br>Сервери<br>Тарифи<br>Баланс</aside><section><h1>Поточний баланс: 4 250 ₴</h1><div class="chart"></div><div class="plans"><article>Cloud Start <b>250 ₴/міс</b></article><article>Cloud Pro <b>600 ₴/міс</b></article><article>Enterprise <b>Ціна за запитом</b></article></div></section></main></div>',
    '<div class="fake-site-screen browser-mockup site-beauty"><div class="browser-bar"><i></i><i></i><i></i><span>essence-aura.ua</span></div><header><b>ESSENCE AURA</b><nav>Парфуми　 Догляд　 Новинки</nav></header><main><h1>Знайди свій<br>унікальний аромат</h1><div class="beauty-grid"><article><strong>Парфумована вода "Oud Noir", 50мл</strong><small>⭐ 4.9 · Хіт продажів</small><b>4 800 ₴</b></article><article><strong>Парфуми "Rose Velvet", 30мл</strong><small>⭐ 4.6</small><b>3 500 ₴</b></article><article><strong>Набір пробників Discovery Set</strong><b>1 400 ₴</b><button>Швидке замовлення</button></article></div></main></div>',
    '<div class="fake-site-screen browser-mockup site-clinic"><div class="browser-bar"><i></i><i></i><i></i><span>clinic-plus.ua</span></div><header><b>CLINIC PLUS</b><span>Гаряча лінія 0 800 000 000</span><button>Запис до лікаря</button></header><main><h1>Турбота, якій<br>можна довіряти</h1><div class="medical-grid"><article><strong>Комплексна чистка зубів AirFlow</strong><small>⭐ 4.9 · Акція</small><b>1 800 ₴</b></article><article><strong>Установка імпланту під ключ</strong><small>⭐ 5.0 · Гарантія 10 років</small><b>від 18 000 ₴</b></article><article><strong>Консультація профільного спеціаліста</strong><b>600 ₴</b><button>Записатися онлайн</button></article></div></main></div>'
  ];
  const tunnelTemplates = [
    '<div class="fake-site-screen site-gastro"><header class="fake-header"><b class="fake-logo">SAVOR</b><nav class="fake-nav"><span>Home</span><span>Menu</span><span>Reserve</span></nav></header><main class="fake-body"><div><span class="fake-kicker">Gastro</span><h2 class="fake-heading">SAVOR</h2><a class="fake-cta">Reserve</a></div><div class="fake-media"></div></main></div>',
    '<div class="fake-site-screen site-sport"><header class="fake-header"><b class="fake-logo">PULSE</b><nav class="fake-nav"><span>Train</span><span>Club</span><span>Join</span></nav></header><main class="fake-body"><aside class="fake-sidebar"><span>01</span><span>Move</span><span>Power</span></aside><h2 class="fake-heading">PULSE</h2><div class="fake-card"></div></main></div>',
    '<div class="fake-site-screen site-fashion"><header class="fake-header"><b class="fake-logo">FORM</b><nav class="fake-nav"><span>Shop</span><span>About</span><span>Journal</span></nav></header><main class="fake-body"><div class="fake-card fake-media"></div><div class="fake-card fake-media"></div><div class="fake-card fake-media"></div><span class="fake-label">HOODIE</span><span class="fake-label">DENIM</span><span class="fake-label">COAT</span></main></div>',
    '<div class="fake-site-screen site-auto"><header class="fake-header"><b class="fake-logo">V—01</b><nav class="fake-nav"><span>Models</span><span>Studio</span><span>Drive</span></nav></header><main class="fake-body"><div class="fake-media"></div><h2 class="fake-heading">VELOCITY</h2><a class="fake-cta">Explore</a></main></div>',
    '<div class="fake-site-screen site-architecture"><header class="fake-header"><b class="fake-logo">ATELIER</b><nav class="fake-nav"><span>Projects</span><span>Practice</span><span>Contact</span></nav></header><main class="fake-body"><div class="fake-card"></div><div class="fake-card"></div><h2 class="fake-heading">SPACE</h2></main></div>',
    '<div class="fake-site-screen site-watches"><header class="fake-header"><b class="fake-logo">CHRONO</b><nav class="fake-nav"><span>Time</span><span>Craft</span><span>Shop</span></nav></header><main class="fake-body"><div class="fake-media"></div><h2 class="fake-heading">CHRONO</h2></main></div>',
    '<div class="fake-site-screen site-resort"><header class="fake-header"><b class="fake-logo">ESCAPE</b><nav class="fake-nav"><span>Stay</span><span>Places</span><span>Stories</span></nav></header><main class="fake-body"><div class="fake-card"></div><h2 class="fake-heading">ESCAPE</h2></main></div>',
    '<div class="fake-site-screen site-tech"><header class="fake-header"><b class="fake-logo">NEXUS</b><nav class="fake-nav"><span>Systems</span><span>Signal</span><span>Access</span></nav></header><main class="fake-body"><h2 class="fake-heading">NEXUS</h2><div class="fake-grid"><div class="fake-card"></div><div class="fake-card"></div><div class="fake-card"></div></div></main></div>',
    '<div class="fake-site-screen site-beauty"><header class="fake-header"><b class="fake-logo">AURA</b><nav class="fake-nav"><span>Essence</span><span>Notes</span><span>Shop</span></nav></header><main class="fake-body"><div class="fake-media"></div><h2 class="fake-heading">AURA</h2></main></div>',
    '<div class="fake-site-screen site-creative"><header class="fake-header"><b class="fake-logo">STUDIO 01</b><nav class="fake-nav"><span>Work</span><span>Field</span><span>Contact</span></nav></header><main class="fake-body"><span class="fake-number n1">01</span><span class="fake-number n2">02</span><span class="fake-number n3">03</span><h2 class="fake-heading">CREATE</h2></main></div>'
  ];
  const templateClasses = ['template-1','template-2','template-3','template-4','template-5','template-6','template-7','template-8','template-9','template-10'];
  for (let floorIndex = 0; floorIndex < 50; floorIndex += 1) {
    const floor = document.createElement('div');
    if (floorIndex === 0) {
      floor.className = 'tunnel-floor intro-floor';
      floor.innerHTML = '<div class="floor-inner"><div class="fake-site-screen"><div class="browser-mockup"><div class="browser-bar"><i></i><i></i><i></i><span>aster-objects.local</span></div></div></div></div>';
    } else {
      const templateIndex = (floorIndex - 1) % browserTemplates.length;
      floor.className = `tunnel-floor ${templateClasses[templateIndex]}`;
      floor.innerHTML = `<div class="floor-inner">${browserTemplates[templateIndex]}</div>`;
    }
    tunnelContainer.appendChild(floor);
  }
  const finalScreen = document.createElement('div');
  finalScreen.className = 'final-screen';
  finalScreen.innerHTML = '<p class="final-line"><span class="line-content">Заказывайте у нас сайты</span></p><a class="final-line instagram-line" href="https://www.instagram.com/lost.spriteee/" target="_blank" rel="noopener noreferrer"><span class="line-content">Instagram: @lost.spriteee</span></a><button class="back-btn" type="button">Назад</button>';
  tunnelContainer.appendChild(finalScreen);
  const finalLines = finalScreen.querySelectorAll('.final-line');
  const backButton = finalScreen.querySelector('.back-btn');
  let tunnelStarted = false;

  startButton.addEventListener('mouseenter', () => gsap.to(startButton, { scale: 1.08, duration: 0.35, ease: 'power2.out' }));
  startButton.addEventListener('mouseleave', () => gsap.to(startButton, { scale: 1, duration: 0.45, ease: 'elastic.out(1, 0.5)' }));
  startButton.addEventListener('click', () => {
    if (tunnelStarted) return;
    tunnelStarted = true;
    startButton.disabled = true;
    lenis.stop();
    document.body.classList.add('tunnel-active');
    gsap.to('.ui-container, .section-note, .section-number, .start-btn', { opacity: 0, duration: 0.45, ease: 'power2.in' });
    gsap.set(tunnelContainer, { display: 'block', opacity: 0, y: 0 });
    const tunnelTimeline = gsap.timeline();
    tunnelTimeline.to(tunnelContainer, {
      opacity: 1,
      duration: 2.2,
      ease: 'power2.inOut'
    });
    tunnelTimeline.to(tunnelContainer, {
      y: '-=5000vh',
      duration: 9,
      ease: 'power4.inOut',
      onComplete: showFinalText
    }, '+=0.05');
    window.__asterTunnelTimeline = tunnelTimeline;
  });

  function showFinalText() {
    const finalTextTimeline = gsap.timeline();
    const lineContents = finalScreen.querySelectorAll('.line-content');
    gsap.set(lineContents, { clipPath: 'inset(0 100% 0 0)' });
    finalTextTimeline.to(lineContents[0], { clipPath: 'inset(0 0% 0 0)', duration: 3, ease: 'power2.out' });
    finalTextTimeline.to(lineContents[1], { clipPath: 'inset(0 0% 0 0)', duration: 3, ease: 'power2.out' }, '+=0.8');
    finalTextTimeline.to(backButton, { opacity: 1, y: 0, duration: 1.2, ease: 'power2.out' }, '+=0.4');
    backButton.addEventListener('click', () => window.location.reload(), { once: true });
    window.__asterTunnelFinalTextShown = true;
    window.__asterFinalTextTimeline = finalTextTimeline;
  }

  function renderFluid(time) {
    fluidUniforms.uPrevious.value = fluidRead.texture;
    fluidUniforms.uMouse.value.set(mouse.uvX, mouse.uvY);
    fluidUniforms.uVelocity.value.set(mouse.velocityX, mouse.velocityY);
    fluidUniforms.uTime.value = time * 0.001;
    renderer.setRenderTarget(fluidWrite);
    renderer.render(fluidScene, postCamera);
    const previousRead = fluidRead;
    fluidRead = fluidWrite;
    fluidWrite = previousRead;
    mouse.velocityX *= 0.88;
    mouse.velocityY *= 0.88;
  }

  function tick(time) {
    const uTime = time * 0.001;
    renderFluid(time);
    mouse.distortionStrength += (mouse.distortionTarget - mouse.distortionStrength) * 0.08;
    mouse.distortionTarget += (0.12 - mouse.distortionTarget) * 0.035;
    finalUniforms.uDistortionStrength.value = mouse.distortionStrength;
    scrollVelocity += (scrollVelocityTarget - scrollVelocity) * 0.12;
    scrollVelocityTarget *= 0.9;
    if (!introComplete) {
      camera.position.x += (0 - camera.position.x) * 0.03;
      camera.position.y += (0 - camera.position.y) * 0.03;
    } else {
      const idleX = Math.sin(uTime * 0.5) * 0.05;
      const idleY = Math.cos(uTime * 0.4) * 0.05;
      camera.position.x += (mouse.targetX * 2.0 + idleX - camera.position.x) * 0.03;
      camera.position.y += (mouse.targetY * 1.5 + idleY - camera.position.y) * 0.03;
    }
    camera.lookAt(0, 0, 0);
    if (titleMesh) {
      const targetSkew = Math.max(-0.2, Math.min(0.2, scrollVelocity * 0.0018));
      titleMesh.rotation.x += (targetSkew - titleMesh.rotation.x) * 0.12;
      titleMesh.rotation.z += (-targetSkew * 0.45 - titleMesh.rotation.z) * 0.12;
    }
    backgroundUniforms.uFluidTexture.value = fluidRead.texture;
    backgroundUniforms.uMouse.value.set(mouse.uvX, mouse.uvY);
    backgroundUniforms.uTime.value = uTime;
    renderer.setRenderTarget(backgroundTarget);
    renderer.render(backgroundScene, postCamera);
    renderer.setRenderTarget(textTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(textScene, camera);
    finalUniforms.uFluidTexture.value = fluidRead.texture;
    finalUniforms.uMouse.value.set(mouse.uvX, mouse.uvY);
    finalUniforms.uTime.value = uTime;
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCamera);
    requestAnimationFrame(tick);
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    textTarget.setSize(window.innerWidth, window.innerHeight);
    backgroundTarget.setSize(window.innerWidth, window.innerHeight);
    backgroundUniforms.uResolution.value.set(window.innerWidth, window.innerHeight);
  });

  const menuPanel = document.querySelector('.menu-panel');
  const menuToggle = document.querySelector('.menu-toggle');
  const menuClose = document.querySelector('.menu-close');
  function setMenu(open) {
    menuPanel.classList.toggle('open', open);
    menuPanel.setAttribute('aria-hidden', String(!open));
    menuToggle.setAttribute('aria-expanded', String(open));
  }
  menuToggle.addEventListener('click', () => setMenu(true));
  menuClose.addEventListener('click', () => setMenu(false));
  document.querySelectorAll('.menu-panel a').forEach((link) => link.addEventListener('click', () => setMenu(false)));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setMenu(false); });

  if (window.matchMedia('(pointer:fine)').matches) {
    const pointerDot = document.createElement('span');
    pointerDot.className = 'pointer-dot';
    document.body.appendChild(pointerDot);
    window.addEventListener('pointermove', (event) => {
      pointerDot.style.left = `${event.clientX}px`;
      pointerDot.style.top = `${event.clientY}px`;
      pointerDot.classList.add('visible');
    }, { passive: true });
  }

  window.__asterFluidStats = { pinkFluidBackground: true, lowerWaterNoise: true, textGeometry: true, fontLoader: true, fluidResolution, rgbRefraction: true, modelsRemoved: true, cameraParallax: true, softTextShadows: true, fogIntro: true, fluidMomentum: true, idleCameraFloat: true, scrollSkew: true, cssTunnel: true, tunnelFloors: 50, simpleFinalReveal: true, blackFinale: true };
  requestAnimationFrame(tick);
});
