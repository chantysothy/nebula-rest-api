var utils = require("../utils.js");
var fs = require("fs");

module.exports = async (event) => {
  var subnet = event.POST.subnet;
  var isNameValid = /^[0-9\.]{4,32}$/.test(subnet);
  if (!isNameValid) {
    return {
      httpStatus: "400",
      headers: { "Content-Type": "application/json" },
      content: {
        status: "KO",
        details:
          "Invalid subnet provided, only numbers and dots are allowed (eg: 10.17.58.0)",
      },
    };
  }

  var requestIp = null;
  if (event.POST.ip && /^[0-9\.]{4,32}$/.test(event.POST.ip))
    requestIp = event.POST.ip;

  var clientName = event.POST.clientName;
  isNameValid = /^[0-9a-zA-Z\.\-]{4,255}$/.test(clientName);
  if (!isNameValid) {
    return {
      httpStatus: "400",
      headers: { "Content-Type": "application/json" },
      content: {
        status: "KO",
        details:
          "Invalid clientName provided, only letters, numbers, dot and dash are allowed",
      },
    };
  }

  var subnetArr = subnet.split(".");
  var compositPath =
    "./nebula/config/networks/" +
    subnetArr[0] +
    "/" +
    subnetArr[1] +
    "/" +
    subnetArr[2] +
    "/" +
    subnetArr[3];
  if (!fs.existsSync(compositPath)) {
    //directory doesnt exists
    return {
      httpStatus: "400",
      headers: { "Content-Type": "application/json" },
      content: {
        status: "KO",
        details: "Network doesn't exist!",
      },
    };
  }

  //get list of already created ips
  var allFiles = [];
  var allIps = "";
  fs.readdirSync(compositPath).forEach((file) => {
    //console.log(file);
    allFiles.push(file);
    allIps += file + ";";
  });

  //find first ip available
  var ipfound = null;
  if (requestIp) ipfound = requestIp;
  else {
    for (var i = 0; i <= 255; i++) {
      var curIP =
        subnetArr[0] + "." + subnetArr[1] + "." + subnetArr[2] + "." + i;
      if (allIps.indexOf(curIP) == -1) {
        ipfound = curIP;
        break;
      }
    }
  }

  if (ipfound == null) {
    return {
      httpStatus: "400",
      headers: { "Content-Type": "application/json" },
      content: {
        status: "KO",
        details:
          "No more ip available in this range, try to delete some unused ip addresses",
      },
    };
  }

  //create certs
  await utils.execCommand(`
    cd ./nebula;
    ./nebula-cert sign -name "${clientName}" -ip "${ipfound}/8" -out-key /tmp/${ipfound}.key -out-crt /tmp/${ipfound}.crt
    `);

  var ca = fs.readFileSync("./nebula/config/ca.crt", {
    encoding: "utf8",
    flag: "r",
  });
  var crt = fs.readFileSync("/tmp/" + ipfound + ".crt", {
    encoding: "utf8",
    flag: "r",
  });
  var key = fs.readFileSync("/tmp/" + ipfound + ".key", {
    encoding: "utf8",
    flag: "r",
  });

  fs.rm("/tmp/" + ipfound + ".crt", { recursive: false }, function () {});
  fs.rm("/tmp/" + ipfound + ".key", { recursive: false }, function () {});

  var static_host_map = `
static_host_map:
  "${process.env.LIGHTHOUSE_IP}": ["${process.env.HOST_DOMAIN}:4243"]    
`;

  var hosts = `
  hosts:
    - "10.255.255.1"
`;

  //Handle custom LH IP
  if (process.env.LIGHTHOUSE_IP != "10.255.255.1") {
    static_host_map = `
static_host_map:
  "${process.env.LIGHTHOUSE_IP}": ["${process.env.HOST_DOMAIN}:4243"]`;

    hosts = `
  hosts:
    - "${process.env.LIGHTHOUSE_IP}"
`;
  }

  //Handle additional LH Nodes
  //console.log("process.env.OTHER_LIGHTHOUSES: ", process.env.OTHER_LIGHTHOUSES)

  if (
    process.env.OTHER_LIGHTHOUSES != null &&
    process.env.OTHER_LIGHTHOUSES != ""
  ) {
    var rows = process.env.OTHER_LIGHTHOUSES.split(";");
    var addedHostMap = "";
    var addedLHNodes = "";
    for (var i = 0; i < rows.length; i++) {
      var curRow = rows[i].split(",");
      addedHostMap += `  "${curRow[0]}": ["${curRow[1]}"]
`;

      addedLHNodes += `    - "${curRow[0]}"
`;
    }

    static_host_map += addedHostMap;
    hosts += addedLHNodes;
  }

  var yml = `
pki:
  # The CAs that are accepted by this node. Must contain one or more certificates created by 'nebula-cert ca'
  ca: /etc/nebula/ca.crt
  cert: /etc/nebula/client.crt
  key: /etc/nebula/client.key

${static_host_map}


lighthouse:
  am_lighthouse: false
  interval: 60
  # hosts is a list of lighthouse hosts this node should report to and query from
  # IMPORTANT: THIS SHOULD BE EMPTY ON LIGHTHOUSE NODES
  # IMPORTANT2: THIS SHOULD BE LIGHTHOUSES' NEBULA IPs, NOT LIGHTHOUSES' REAL ROUTABLE IPs
  ${hosts}

listen:
  # To listen on both any ipv4 and ipv6 use "[::]"
  host: 0.0.0.0
  port: 4242

punchy:
  # Continues to punch inbound/outbound at a regular interval to avoid expiration of firewall nat mappings
  punch: true

tun:
  disabled: false
  dev: nebula1
  drop_local_broadcast: false
  drop_multicast: false
  tx_queue: 500
  mtu: 1300

logging:
  level: info
  format: text

  
firewall:
  conntrack:
    tcp_timeout: 12m
    udp_timeout: 3m
    default_timeout: 10m
    max_connections: 100000

  outbound:
    # Allow all outbound traffic from this node
    - port: any
      proto: any
      host: any

  inbound:
    # Allow all traffic from any host on same subnet
    - port: any
      proto: any
      cidr: ${subnet}/24
`;

  var response = {
    status: "OK",
    CIDR: ipfound + "/8",
    ca: ca,
    crt: crt,
    key: key,
    clientName: clientName,
    clientYML: yml,
  };

  var fileWriteResult = fs.writeFileSync(
    compositPath + "/" + ipfound,
    JSON.stringify(response, null, 4)
  );
  //console.log(compositPath + "/" + ipfound)
  //console.log(fileWriteResult)

  return {
    httpStatus: "200",
    headers: { "Content-Type": "application/json" },
    content: response,
  };
};
