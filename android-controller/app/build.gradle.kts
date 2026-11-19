import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 「纯公网 IP + 明文 HTTP」专用正式包的可选构建参数（-P）：
//   -PrelayDefaultUrl=http://8.138.221.245:3000 -PrelayAllowCleartext=true
// 不带参数时 release 保持默认安全语义：强制 HTTPS、不预置地址。
// 实际构建请用 scripts/build-apk-ip-http.sh，产物落在 dist/ip-http/。
val relayDefaultUrl: String = (project.findProperty("relayDefaultUrl") as? String)
    ?.trim()
    ?.replace("\\", "\\\\")
    ?.replace("\"", "\\\"")
    .orEmpty()
val relayAllowCleartext: Boolean =
    (project.findProperty("relayAllowCleartext") as? String)?.toBoolean() == true

if (relayDefaultUrl.startsWith("http://") && !relayAllowCleartext) {
    throw GradleException(
        "DEFAULT_SERVER 是明文 http://，必须同时传 -PrelayAllowCleartext=true，" +
            "否则 release 包会拒绝该地址（请改用 scripts/build-apk-ip-http.sh）"
    )
}

// 正式包签名：密钥库与密码放在仓库根 keystore.properties（.gitignore 已排除）。
// 文件缺失时 debug 构建不受影响，但 release 包不带签名，分发前须用 apksigner 校验。
val signingPropsFile = rootProject.file("../keystore.properties")
val signingProps = Properties().apply {
    if (signingPropsFile.exists()) signingPropsFile.inputStream().use { load(it) }
}

android {
    signingConfigs {
        if (signingPropsFile.exists()) {
            create("release") {
                storeFile = rootProject.file(signingProps.getProperty("storeFile"))
                storePassword = signingProps.getProperty("storePassword")
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    namespace = "com.pcxx.remote.controller"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.pcxx.remote.controller"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
        // 由 src/release/AndroidManifest.xml 使用；默认 false，仅带 -P 参数构建时为 true
        manifestPlaceholders["cleartextEnabled"] = if (relayAllowCleartext) "true" else "false"
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        debug {
            // 仅调试包预置跨网联调用的临时隧道地址，绝不进入 release 产物
            buildConfigField("String", "DEFAULT_SERVER", "\"http://sfedf6bb.natappfree.cc\"")
            buildConfigField("boolean", "ALLOW_CLEARTEXT", "true")
        }
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (signingConfigs.findByName("release") != null) {
                signingConfig = signingConfigs.getByName("release")
            }
            // 默认不预置地址且强制 HTTPS；仅带 -P 参数构建「IP 明文专用包」时覆盖
            buildConfigField("String", "DEFAULT_SERVER", "\"$relayDefaultUrl\"")
            buildConfigField("boolean", "ALLOW_CLEARTEXT", "$relayAllowCleartext")
        }
    }

    // lintVitalAnalyzeRelease 需要联网拉取 lint-gradle，离线构建会失败。
    // 正式包构建保持离线可复现；需要完整检查时联网单独执行 :app:lintRelease。
    lint {
        checkReleaseBuilds = false
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
}
