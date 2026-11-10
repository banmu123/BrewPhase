pluginManagement {
    repositories {
        // 官方源：阿里云镜像对 HEAD 请求返回 502，而 Gradle 解析依赖依赖 HEAD，
        // 会把插件解析直接打断（POM 的 GET 反而是 200，很容易误判）。
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "BrewPhaseAndroid"
include(":app")
