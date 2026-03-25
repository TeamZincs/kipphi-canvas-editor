import json
import semver
import subprocess

import subprocess
import re
import sys

def call(cmd, cwd=None):
    input(f"Will execute: [{cwd or '.'}]" + subprocess.list2cmdline(cmd))
    return subprocess.call(cmd, shell=True, cwd=cwd)



def bump():

    with open("./node_modules/kipphi/package.json", "r", encoding="utf-8") as f:
        kipphi_package_json = json.load(f)

    with open("./node_modules/kipphi-player/package.json", "r", encoding="utf-8") as f:
        kipphi_player_package_json = json.load(f)

    with open("./package.json", "r", encoding="utf-8") as f:
        package_json = json.load(f)
        print("当前package.json：", package_json)
    print(f"kipphi版本：{kipphi_package_json['version']}")
    print(f"kipphi-player版本：{kipphi_player_package_json['version']}")
    print(f"当前本包版本：{package_json['version']}")
    print("已将本包依赖kipphi和kipphi-player版本升级为最新版本")
    package_json['dependencies']['kipphi'] = kipphi_package_json['version']
    package_json['dependencies']['kipphi-player'] = kipphi_player_package_json['version']

    ver = input("请输入新版本号，留空则直接使用kipphi版本号：")
    ver = ver if ver else kipphi_package_json['version']
    package_json['version'] = ver

    with open("./package.json", "w", encoding="utf-8") as f:
        json.dump(package_json, f, indent=4, ensure_ascii=False)
    
    print(f"已将本包版本号升级为{ver}")

    print("提交到Git？")
    call(["git", "add", "./package.json"])
    call(["git", "commit", "-m", f"chore: bump to {ver}"])
    call(["git", "push"])

def send_to_npm():
    print("发布到NPM")
    # print("先build一下")
    # call(["npm", "run", "build"], ".")
    call(["npm", "publish", "--registry", "https://registry.npmjs.org/", "--dry"], ".")
    print("请确认刚刚的输出是否正确")
    call(["npm", "publish", "--registry", "https://registry.npmjs.org/"], ".")

if __name__ == "__main__":
    if sys.argv[1] == "npm":
        send_to_npm()
    else:
        bump()


    