#!/bin/bash

# ========================================
# 冬瓜TV MAX 一键安装脚本
# 适用于 Ubuntu/Debian/CentOS 系统
# ========================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 打印带颜色的消息
print_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 检测系统类型
detect_os() {
    if [ -f /etc/debian_version ]; then
        OS="debian"
        PKG_MANAGER="apt-get"
    elif [ -f /etc/redhat-release ]; then
        OS="rhel"
        PKG_MANAGER="yum"
    else
        print_error "不支持的操作系统"
        exit 1
    fi
}

# 安装编译工具 (better-sqlite3 需要)
install_build_tools() {
    print_info "检测编译工具..."
    
    if command -v gcc &> /dev/null && command -v make &> /dev/null; then
        print_success "编译工具已安装"
        return
    fi
    
    print_info "正在安装编译工具 (better-sqlite3 原生模块需要)..."
    
    if [ "$OS" = "debian" ]; then
        sudo apt-get update
        sudo apt-get install -y build-essential python3
    else
        sudo yum groupinstall -y "Development Tools"
        sudo yum install -y python3
    fi
    
    print_success "编译工具安装完成"
}

# 安装 Node.js
install_nodejs() {
    print_info "检测 Node.js..."
    
    if command -v node &> /dev/null; then
        NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        # 18/20 已停止维护(EOL),不再有安全修复;better-sqlite3 也不支持 18
        if [ "$NODE_VERSION" -ge 22 ]; then
            print_success "Node.js $(node -v) 已安装"
            return
        else
            print_warning "Node.js $(node -v) 已停止维护，需要 v22+，正在升级..."
        fi
    fi

    print_info "正在安装 Node.js v22..."

    if [ "$OS" = "debian" ]; then
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        sudo apt-get install -y nodejs
    else
        curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
        sudo yum install -y nodejs
    fi
    
    print_success "Node.js $(node -v) 安装完成"
}

# 安装 PM2
install_pm2() {
    print_info "检测 PM2..."
    
    if command -v pm2 &> /dev/null; then
        print_success "PM2 已安装"
        return
    fi
    
    print_info "正在安装 PM2..."
    sudo npm install -g pm2
    print_success "PM2 安装完成"
}

# 安装 Git
install_git() {
    print_info "检测 Git..."
    
    if command -v git &> /dev/null; then
        print_success "Git 已安装"
        return
    fi
    
    print_info "正在安装 Git..."
    if [ "$OS" = "debian" ]; then
        sudo apt-get update
        sudo apt-get install -y git
    else
        sudo yum install -y git
    fi
    print_success "Git 安装完成"
}

# 获取用户输入
get_user_input() {
    echo ""
    echo "=========================================="
    echo "        冬瓜TV MAX 配置向导"
    echo "=========================================="
    echo ""
    
    # TMDB API Key
    while true; do
        read -p "请输入您的 TMDB API Key (必填): " TMDB_API_KEY
        if [ -n "$TMDB_API_KEY" ]; then
            break
        else
            print_error "TMDB API Key 不能为空！"
        fi
    done
    
    # TMDB Proxy URL
    echo ""
    print_info "如果您部署在大陆服务器或主要面向大陆用户，请配置 TMDB 反代地址"
    print_info "反代部署说明：https://github.com/ednovas/dongguaTV#大陆用户配置"
    read -p "请输入 TMDB 反代地址 (可选，回车跳过): " TMDB_PROXY_URL
    
    # 端口
    echo ""
    read -p "请输入运行端口 (默认 3000): " PORT
    PORT=${PORT:-3000}

    # 缓存模式
    echo ""
    echo "请选择缓存模式:"
    echo "1) JSON文件 (默认, 简单易用)"
    echo "2) SQLite (推荐, 高性能)"
    echo "3) 纯内存 (重启即丢失)"
    echo "4) 不缓存 (开发调试用)"
    read -p "请输入选项 [1-4]: " CACHE_OPT
    case $CACHE_OPT in
        2) CACHE_TYPE="sqlite";;
        3) CACHE_TYPE="memory";;
        4) CACHE_TYPE="none";;
        *) CACHE_TYPE="json";;
    esac

    # 访问密码
    echo ""
    read -p "请输入访问密码 (默认为空/不设置): " ACCESS_PASSWORD
    
    # 安装目录
    echo ""
    read -p "请输入安装目录 (默认 /opt/dongguaTV): " INSTALL_DIR
    INSTALL_DIR=${INSTALL_DIR:-/opt/dongguaTV}
    
    echo ""
    echo "=========================================="
    echo "        配置确认"
    echo "=========================================="
    echo "TMDB API Key: ${TMDB_API_KEY:0:8}..."
    echo "TMDB 反代地址: ${TMDB_PROXY_URL:-未配置}"
    echo "运行端口: $PORT"
    echo "缓存模式: $CACHE_TYPE"
    echo "访问密码: ${ACCESS_PASSWORD:-未设置}"
    echo "安装目录: $INSTALL_DIR"
    echo "=========================================="
    echo ""
    
    read -p "确认以上配置？(Y/n): " CONFIRM
    CONFIRM=${CONFIRM:-Y}
    
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        print_warning "已取消安装"
        exit 0
    fi
}

# 下载项目
download_project() {
    print_info "正在下载项目..."
    
    if [ -d "$INSTALL_DIR" ]; then
        print_warning "目录 $INSTALL_DIR 已存在"
        read -p "是否删除并重新安装？(y/N): " OVERWRITE
        if [[ "$OVERWRITE" =~ ^[Yy]$ ]]; then
            sudo rm -rf "$INSTALL_DIR"
        else
            print_info "使用现有目录，跳过下载"
            return
        fi
    fi
    
    sudo mkdir -p "$INSTALL_DIR"
    sudo chown $USER:$USER "$INSTALL_DIR"
    
    git clone https://github.com/ednovas/dongguaTV.git "$INSTALL_DIR"
    print_success "项目下载完成"
}

# 安装依赖
install_dependencies() {
    print_info "正在安装项目依赖..."
    cd "$INSTALL_DIR"
    npm install
    print_success "依赖安装完成"
}

# 配置环境变量
configure_env() {
    print_info "正在配置环境变量..."
    
    cat > "$INSTALL_DIR/.env" << EOF
# 冬瓜TV MAX 配置文件
# 由一键安装脚本自动生成

# TMDb API Key (必填)
TMDB_API_KEY=$TMDB_API_KEY

# 运行端口
PORT=$PORT

# 大陆用户 TMDB 反代地址 (可选)
TMDB_PROXY_URL=$TMDB_PROXY_URL

# 缓存类型
CACHE_TYPE=$CACHE_TYPE

# 访问密码 (可选)
ACCESS_PASSWORD=$ACCESS_PASSWORD
EOF

    print_success "环境变量配置完成"
}

# 启动服务
start_service() {
    print_info "正在启动服务..."
    
    cd "$INSTALL_DIR"
    
    # 检查是否已有运行的实例
    if pm2 list | grep -q "donggua-tv"; then
        print_warning "检测到已有运行的实例，正在重启..."
        pm2 restart donggua-tv
    else
        pm2 start server.js --name "donggua-tv"
    fi
    
    # 保存 PM2 配置并设置开机自启
    pm2 save
    
    # 设置开机自启 (忽略错误)
    sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u $USER --hp $HOME 2>/dev/null || true
    
    print_success "服务启动完成"
}

# 显示完成信息
show_complete() {
    echo ""
    echo "=========================================="
    echo -e "${GREEN}        安装完成！${NC}"
    echo "=========================================="
    echo ""
    
    # 获取服务器 IP
    SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
    
    echo -e "访问地址: ${GREEN}http://$SERVER_IP:$PORT${NC}"
    echo ""
    echo "常用命令:"
    echo "  查看状态: pm2 status"
    echo "  查看日志: pm2 logs donggua-tv"
    echo "  重启服务: pm2 restart donggua-tv"
    echo "  停止服务: pm2 stop donggua-tv"
    echo ""
    echo "配置文件: $INSTALL_DIR/.env"
    echo "缓存数据: $INSTALL_DIR/cache.db (SQLite)"
    echo "项目目录: $INSTALL_DIR"
    echo ""
    echo "=========================================="
    echo -e "${YELLOW}如需使用域名访问，请配置 Nginx 反向代理${NC}"
    echo "=========================================="
}

# 主函数
main() {
    echo ""
    echo "=========================================="
    echo "     冬瓜TV MAX 一键安装脚本 v1.1"
    echo "=========================================="
    echo ""
    
    # 检测系统
    detect_os
    print_info "检测到系统: $OS"
    
    # 获取用户输入
    get_user_input
    
    # 安装依赖
    install_git
    
    # 仅当选择 SQLite 缓存时安装编译工具
    if [ "$CACHE_TYPE" = "sqlite" ]; then
        install_build_tools
    fi
    
    install_nodejs
    install_pm2
    
    # 下载并配置项目
    download_project
    install_dependencies
    configure_env
    
    # 启动服务
    start_service
    
    # 显示完成信息
    show_complete
}

# 运行主函数
main
